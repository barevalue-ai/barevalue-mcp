#!/usr/bin/env node

/**
 * Barevalue MCP Server
 *
 * Model Context Protocol server for the Barevalue AI podcast editing API.
 * Allows Claude Code and other MCP-compatible tools to submit and manage
 * podcast editing orders programmatically.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { BarevalueApiClient, BarevalueApiError } from './api-client.js';

/**
 * Sanitize strings to remove unpaired Unicode surrogates (U+D800-U+DFFF).
 * These cause "no low surrogate" JSON parsing errors in Claude Code.
 */
function sanitizeString(str: string): string {
  // Replace unpaired surrogates with the Unicode replacement character
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/**
 * Recursively sanitize all strings in an object/array to remove surrogates.
 */
function sanitizeData(data: unknown): unknown {
  if (typeof data === 'string') {
    return sanitizeString(data);
  }
  if (Array.isArray(data)) {
    return data.map(sanitizeData);
  }
  if (data !== null && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[sanitizeString(key)] = sanitizeData(value);
    }
    return result;
  }
  return data;
}

// Tool definitions
const TOOLS = [
  // Account
  {
    name: 'barevalue_account',
    description:
      'Get Barevalue account information including credit balance, AI subscription status, bonus minutes, and pricing. Use this to check available balance before submitting orders.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  // Estimate
  {
    name: 'barevalue_estimate',
    description:
      'Calculate the cost of an AI podcast editing order before submission. Returns breakdown of AI bonus minutes, subscription minutes, credits, and payment required.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        duration_minutes: {
          type: 'number',
          description: 'Audio duration in minutes (1-300)',
        },
      },
      required: ['duration_minutes'],
    },
  },
  // Upload
  {
    name: 'barevalue_upload',
    description:
      'Upload an audio file for AI podcast editing. Handles getting a presigned S3 URL and uploading the file. Returns order_id and s3_key needed for submission. Maximum file size: 750MB.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description:
            'Absolute path to the audio file (supported: mp3, wav, m4a, flac, aac, ogg, aiff)',
        },
        filename: {
          type: 'string',
          description: 'Optional display name for the file. Defaults to original filename.',
        },
      },
      required: ['file_path'],
    },
  },
  // Validate
  {
    name: 'barevalue_validate',
    description:
      'Pre-check an audio file from a URL before submission. Validates speech content (minimum 10%) and detects music-only content. Does NOT charge credits. Use this for external URLs before submitting. Note: For files uploaded via barevalue_upload, validation is not needed - go directly to submit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_url: {
          type: 'string',
          description: 'Public URL to the audio file to validate',
        },
      },
      required: ['file_url'],
    },
  },
  // Submit (uploaded file)
  {
    name: 'barevalue_submit',
    description:
      'Submit an uploaded audio file for AI podcast editing. Charges credits/subscription minutes. Requires order_id and s3_key from barevalue_upload.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        order_id: {
          type: 'number',
          description: 'Order ID from barevalue_upload',
        },
        s3_key: {
          type: 'string',
          description: 'S3 key from barevalue_upload',
        },
        podcast_name: {
          type: 'string',
          description: 'Name of the podcast',
        },
        episode_name: {
          type: 'string',
          description: 'Name of this episode',
        },
        episode_number: {
          type: 'string',
          description: 'Optional episode number (e.g., "42", "S2E5")',
        },
        special_instructions: {
          type: 'string',
          description:
            'Optional custom instructions for the AI editor (max 2000 chars). Examples: "Remove all mentions of our sponsor", "Keep the blooper at the end"',
        },
        processing_style: {
          type: 'string',
          enum: ['standard', 'minimal', 'aggressive'],
          description:
            'How much editing to apply. standard: balanced cleanup, minimal: light touch, aggressive: heavy editing for maximum polish. Default: standard',
        },
        host_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional names of hosts (max 5) for speaker identification in transcript',
        },
        guest_names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional names of guests (max 10) for speaker identification in transcript',
        },
      },
      required: ['order_id', 's3_key', 'podcast_name', 'episode_name'],
    },
  },
  // Submit from URL
  {
    name: 'barevalue_submit_url',
    description:
      'Submit a podcast for AI editing using a public URL. The file will be downloaded and processed. Useful for files hosted on Dropbox, Google Drive (with public link), or other file hosting services.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_url: {
          type: 'string',
          description:
            'Public URL to the audio file. Must be directly downloadable (not a landing page).',
        },
        podcast_name: {
          type: 'string',
          description: 'Name of the podcast',
        },
        episode_name: {
          type: 'string',
          description: 'Name of this episode',
        },
        episode_number: {
          type: 'string',
          description: 'Optional episode number',
        },
        special_instructions: {
          type: 'string',
          description: 'Optional custom instructions for the AI editor (max 2000 chars)',
        },
        processing_style: {
          type: 'string',
          enum: ['standard', 'minimal', 'aggressive'],
          description: 'How much editing to apply. Default: standard',
        },
        host_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional names of hosts (max 5)',
        },
        guest_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional names of guests (max 10)',
        },
      },
      required: ['file_url', 'podcast_name', 'episode_name'],
    },
  },
  // Status
  {
    name: 'barevalue_status',
    description:
      'Check the status of an order. Returns current processing state and, when complete, download URLs for edited audio, transcript PDF, transcript DOCX, and show notes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        order_id: {
          type: 'number',
          description: 'Order ID to check',
        },
      },
      required: ['order_id'],
    },
  },
  // List Orders
  {
    name: 'barevalue_list_orders',
    description:
      'List recent orders with their status. Useful for checking on multiple orders or finding a specific order.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        page: {
          type: 'number',
          description: 'Page number (default: 1)',
        },
        per_page: {
          type: 'number',
          description: 'Results per page (default: 20, max: 100)',
        },
        status: {
          type: 'string',
          enum: ['pending', 'processing', 'completed', 'failed'],
          description: 'Filter by status',
        },
      },
      required: [],
    },
  },
  // Webhooks - List
  {
    name: 'barevalue_webhooks_list',
    description:
      'List all configured webhooks for your account. Webhooks send notifications when orders complete, fail, or are refunded.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  // Webhooks - Create
  {
    name: 'barevalue_webhook_create',
    description:
      'Create a new webhook to receive notifications. Returns the webhook with its signing secret (shown only once - save it!).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'HTTPS URL to receive webhook payloads',
        },
        events: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['order.completed', 'order.failed', 'order.refunded'],
          },
          description:
            'Events to subscribe to. Options: order.completed, order.failed, order.refunded',
        },
      },
      required: ['url', 'events'],
    },
  },
  // Webhooks - Update
  {
    name: 'barevalue_webhook_update',
    description: 'Update an existing webhook URL, events, or active status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        webhook_id: {
          type: 'number',
          description: 'Webhook ID to update',
        },
        url: {
          type: 'string',
          description: 'New HTTPS URL',
        },
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'New events list',
        },
        is_active: {
          type: 'boolean',
          description: 'Enable or disable the webhook',
        },
      },
      required: ['webhook_id'],
    },
  },
  // Webhooks - Delete
  {
    name: 'barevalue_webhook_delete',
    description: 'Delete a webhook. This cannot be undone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        webhook_id: {
          type: 'number',
          description: 'Webhook ID to delete',
        },
      },
      required: ['webhook_id'],
    },
  },
  // Webhooks - Rotate Secret
  {
    name: 'barevalue_webhook_rotate_secret',
    description:
      'Generate a new signing secret for a webhook. The old secret will immediately stop working. Returns the new secret (shown only once).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        webhook_id: {
          type: 'number',
          description: 'Webhook ID to rotate secret for',
        },
      },
      required: ['webhook_id'],
    },
  },
];

// Initialize API client
let apiClient: BarevalueApiClient | null = null;

function getApiClient(): BarevalueApiClient {
  if (!apiClient) {
    try {
      apiClient = new BarevalueApiClient();
    } catch (error) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        error instanceof Error ? error.message : 'Failed to initialize API client'
      );
    }
  }
  return apiClient;
}

// Tool handler
async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const client = getApiClient();

  try {
    let result: unknown;

    switch (name) {
      case 'barevalue_account': {
        result = await client.getAccount();
        break;
      }

      case 'barevalue_estimate': {
        const duration = args.duration_minutes as number;
        if (duration < 1 || duration > 300) {
          throw new Error('Duration must be between 1 and 300 minutes');
        }
        result = await client.estimate(duration);
        break;
      }

      case 'barevalue_upload': {
        const filePath = args.file_path as string;
        const filename = args.filename as string | undefined;
        result = await client.uploadFile(filePath, filename);
        break;
      }

      case 'barevalue_validate': {
        const fileUrl = args.file_url as string;
        result = await client.validate(fileUrl);
        break;
      }

      case 'barevalue_submit': {
        const idempotencyKey = randomUUID();
        result = await client.submitUploadedOrder({
          order_id: args.order_id as number,
          s3_key: args.s3_key as string,
          podcast_name: args.podcast_name as string,
          episode_name: args.episode_name as string,
          episode_number: args.episode_number as string | undefined,
          special_instructions: args.special_instructions as string | undefined,
          processing_style: args.processing_style as 'standard' | 'minimal' | 'aggressive' | undefined,
          host_names: args.host_names as string[] | undefined,
          guest_names: args.guest_names as string[] | undefined,
          idempotency_key: idempotencyKey,
        });
        break;
      }

      case 'barevalue_submit_url': {
        const idempotencyKey = randomUUID();
        result = await client.submitExternalUrl({
          file_url: args.file_url as string,
          podcast_name: args.podcast_name as string,
          episode_name: args.episode_name as string,
          episode_number: args.episode_number as string | undefined,
          special_instructions: args.special_instructions as string | undefined,
          processing_style: args.processing_style as 'standard' | 'minimal' | 'aggressive' | undefined,
          host_names: args.host_names as string[] | undefined,
          guest_names: args.guest_names as string[] | undefined,
          idempotency_key: idempotencyKey,
        });
        break;
      }

      case 'barevalue_status': {
        result = await client.getOrderStatus(args.order_id as number);
        break;
      }

      case 'barevalue_list_orders': {
        result = await client.listOrders({
          page: args.page as number | undefined,
          per_page: args.per_page as number | undefined,
          status: args.status as string | undefined,
        });
        break;
      }

      case 'barevalue_webhooks_list': {
        result = await client.listWebhooks();
        break;
      }

      case 'barevalue_webhook_create': {
        const url = args.url as string;
        const events = args.events as string[];
        result = await client.createWebhook(url, events);
        // Add note about saving the secret
        const webhook = result as { secret?: string };
        if (webhook.secret) {
          result = {
            ...webhook,
            _note: 'IMPORTANT: Save the secret above. It will only be shown once!',
          };
        }
        break;
      }

      case 'barevalue_webhook_update': {
        const webhookId = args.webhook_id as number;
        const updates: { url?: string; events?: string[]; is_active?: boolean } = {};
        if (args.url) updates.url = args.url as string;
        if (args.events) updates.events = args.events as string[];
        if (args.is_active !== undefined) updates.is_active = args.is_active as boolean;
        result = await client.updateWebhook(webhookId, updates);
        break;
      }

      case 'barevalue_webhook_delete': {
        result = await client.deleteWebhook(args.webhook_id as number);
        break;
      }

      case 'barevalue_webhook_rotate_secret': {
        result = await client.rotateWebhookSecret(args.webhook_id as number);
        const webhook = result as { secret?: string };
        if (webhook.secret) {
          result = {
            ...webhook,
            _note: 'IMPORTANT: Save the new secret above. The old secret no longer works!',
          };
        }
        break;
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    // Sanitize result to remove unpaired surrogates before JSON serialization
    const sanitizedResult = sanitizeData(result);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(sanitizedResult, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof BarevalueApiError) {
      // Sanitize error details which may contain API response data
      const sanitizedDetails = sanitizeData(error.details);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: error.code,
                message: sanitizeString(error.message),
                statusCode: error.statusCode,
                details: sanitizedDetails,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (error instanceof McpError) {
      throw error;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'tool_error',
              message: sanitizeString(error instanceof Error ? error.message : 'Unknown error occurred'),
            },
            null,
            2
          ),
        },
      ],
    };
  }
}

// Main server setup
async function main() {
  const server = new Server(
    {
      name: 'barevalue-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle list tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args as Record<string, unknown>);
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log startup (to stderr so it doesn't interfere with stdio protocol)
  console.error('Barevalue MCP server started');
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
