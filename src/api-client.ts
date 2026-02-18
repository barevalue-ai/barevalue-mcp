/**
 * Barevalue API Client
 *
 * HTTP wrapper for the Barevalue API v1 with authentication handling.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import type {
  AccountInfo,
  EstimateResponse,
  UploadUrlResponse,
  UploadUrlsResponse,
  ValidationResponse,
  SubmitResponse,
  OrderStatus,
  OrderListResponse,
  WebhookListResponse,
  Webhook,
  ApiError,
} from './types.js';

export class BarevalueApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey || process.env.BAREVALUE_API_KEY || '';
    this.baseUrl = baseUrl || process.env.BAREVALUE_API_URL || 'https://barevalue.com/api/v1';
    this.timeout = 30000; // 30 seconds

    if (!this.apiKey) {
      throw new Error(
        'Barevalue API key is required. Set BAREVALUE_API_KEY environment variable or pass it to the constructor.'
      );
    }

    if (!this.apiKey.startsWith('bv_sk_')) {
      throw new Error(
        'Invalid API key format. Barevalue API keys must start with "bv_sk_".'
      );
    }

    // Security: Warn if using non-HTTPS for non-localhost URLs
    const url = new URL(this.baseUrl);
    const isHttps = url.protocol === 'https:';
    if (!isHttps && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      console.error('WARNING: Using non-HTTPS connection. API key may be transmitted insecurely.');
    }
  }

  /**
   * Make an HTTP request to the Barevalue API
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    // Construct full URL by appending endpoint to base URL
    // Remove leading slash from endpoint if base URL doesn't end with slash
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    const cleanBase = this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/';
    const fullUrl = cleanBase + cleanEndpoint;

    const url = new URL(fullUrl);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'barevalue-mcp/1.0.0',
      },
      timeout: this.timeout,
    };

    return new Promise((resolve, reject) => {
      const req = httpModule.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);

            if (res.statusCode && res.statusCode >= 400) {
              const error = parsed as ApiError;
              reject(new BarevalueApiError(
                error.message || 'API request failed',
                error.error || 'unknown_error',
                res.statusCode,
                error.details
              ));
              return;
            }

            resolve(parsed as T);
          } catch {
            // Security: Don't expose raw API response data in error messages
            reject(new Error('Failed to parse API response'));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`API request failed: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('API request timed out'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Upload a file to S3 using a presigned URL
   */
  private async uploadToS3(uploadUrl: string, filePath: string, contentType: string): Promise<void> {
    const fileBuffer = fs.readFileSync(filePath);
    const url = new URL(uploadUrl);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileBuffer.length,
      },
      timeout: 300000, // 5 minutes for upload
    };

    return new Promise((resolve, reject) => {
      const req = httpModule.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            // Security: Don't expose S3 error response data
            reject(new Error(`S3 upload failed with status ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`S3 upload failed: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('S3 upload timed out'));
      });

      req.write(fileBuffer);
      req.end();
    });
  }

  /**
   * Get content type from file extension
   */
  private getContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const types: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.wma': 'audio/x-ms-wma',
      '.aiff': 'audio/aiff',
      '.aif': 'audio/aiff',
    };
    return types[ext] || 'application/octet-stream';
  }

  // ============================================
  // Account Endpoints
  // ============================================

  /**
   * Get account information including balance, subscription, and pricing
   */
  async getAccount(): Promise<AccountInfo> {
    return this.request<AccountInfo>('GET', '/account');
  }

  // ============================================
  // Order Endpoints
  // ============================================

  /**
   * Get cost estimate for an order
   */
  async estimate(durationMinutes: number): Promise<EstimateResponse> {
    return this.request<EstimateResponse>('POST', '/orders/estimate', {
      duration_minutes: durationMinutes,
    });
  }

  /**
   * Get a presigned upload URL for a single file
   */
  async getUploadUrl(filename: string, contentType: string): Promise<UploadUrlResponse> {
    return this.request<UploadUrlResponse>('POST', '/orders/upload-url', {
      filename,
      content_type: contentType,
    });
  }

  /**
   * Get presigned upload URLs for multiple files (multi-track)
   */
  async getUploadUrls(
    files: Array<{ filename: string; content_type: string; role: string }>
  ): Promise<UploadUrlsResponse> {
    return this.request<UploadUrlsResponse>('POST', '/orders/upload-urls', { files });
  }

  /**
   * Upload a file to Barevalue
   * Handles: get presigned URL -> upload to S3 -> return order details
   */
  async uploadFile(filePath: string, filename?: string): Promise<UploadUrlResponse> {
    // Security: Resolve path and block sensitive system directories
    const resolvedPath = path.resolve(filePath);
    const sensitivePatterns = [
      /^\/etc\//,
      /^\/var\//,
      /^\/usr\//,
      /^\/root\//,
      /[/\\]\.ssh[/\\]/,
      /[/\\]\.aws[/\\]/,
      /[/\\]\.gnupg[/\\]/,
      /[/\\]\.config[/\\]/,
      /[/\\]\.env$/,
      /[/\\]\.env\./,
    ];

    if (sensitivePatterns.some(p => p.test(resolvedPath))) {
      throw new Error('Access denied: Cannot upload files from sensitive system directories');
    }

    // Validate file exists
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Get file stats
    const stats = fs.statSync(resolvedPath);
    const maxSize = 750 * 1024 * 1024; // 750MB
    if (stats.size > maxSize) {
      throw new Error(`File too large. Maximum size is 750MB, file is ${Math.round(stats.size / 1024 / 1024)}MB`);
    }

    // Determine filename and content type
    const actualFilename = filename || path.basename(resolvedPath);
    const contentType = this.getContentType(resolvedPath);

    // Validate file type
    const validExtensions = ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma', '.aiff', '.aif'];
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!validExtensions.includes(ext)) {
      throw new Error(
        `Invalid file type: ${ext}. Supported types: ${validExtensions.join(', ')}`
      );
    }

    // Get presigned URL
    const uploadInfo = await this.getUploadUrl(actualFilename, contentType);

    // Upload to S3
    await this.uploadToS3(uploadInfo.upload_url, resolvedPath, contentType);

    return uploadInfo;
  }

  /**
   * Validate a file from URL before submission
   */
  async validate(fileUrl: string): Promise<ValidationResponse> {
    return this.request<ValidationResponse>('POST', '/orders/validate', {
      file_url: fileUrl,
    });
  }

  /**
   * Submit an uploaded order for processing
   */
  async submitUploadedOrder(params: {
    order_id: number;
    s3_key: string;
    podcast_name: string;
    episode_name: string;
    episode_number?: string;
    special_instructions?: string;
    processing_style?: 'standard' | 'minimal' | 'aggressive';
    host_names?: string[];
    guest_names?: string[];
    idempotency_key: string;
  }): Promise<SubmitResponse> {
    return this.request<SubmitResponse>('POST', '/orders/submit', params);
  }

  /**
   * Submit an order using an external URL
   */
  async submitExternalUrl(params: {
    file_url: string;
    podcast_name: string;
    episode_name: string;
    episode_number?: string;
    special_instructions?: string;
    processing_style?: 'standard' | 'minimal' | 'aggressive';
    host_names?: string[];
    guest_names?: string[];
    idempotency_key: string;
  }): Promise<SubmitResponse> {
    return this.request<SubmitResponse>('POST', '/orders/submit', params);
  }

  /**
   * Get order status
   */
  async getOrderStatus(orderId: number): Promise<OrderStatus> {
    return this.request<OrderStatus>('GET', `/orders/${orderId}`);
  }

  /**
   * List orders (requires API endpoint - may need to be added)
   */
  async listOrders(params?: {
    page?: number;
    per_page?: number;
    status?: string;
  }): Promise<OrderListResponse> {
    const queryParams = new URLSearchParams();
    if (params?.page) queryParams.set('page', params.page.toString());
    if (params?.per_page) queryParams.set('per_page', params.per_page.toString());
    if (params?.status) queryParams.set('status', params.status);

    const query = queryParams.toString();
    const endpoint = query ? `/orders?${query}` : '/orders';
    return this.request<OrderListResponse>('GET', endpoint);
  }

  // ============================================
  // Webhook Endpoints
  // ============================================

  /**
   * List all webhooks
   */
  async listWebhooks(): Promise<WebhookListResponse> {
    return this.request<WebhookListResponse>('GET', '/webhooks');
  }

  /**
   * Create a webhook
   */
  async createWebhook(url: string, events: string[]): Promise<Webhook> {
    return this.request<Webhook>('POST', '/webhooks', { url, events });
  }

  /**
   * Get a specific webhook
   */
  async getWebhook(webhookId: number): Promise<Webhook> {
    return this.request<Webhook>('GET', `/webhooks/${webhookId}`);
  }

  /**
   * Update a webhook
   */
  async updateWebhook(
    webhookId: number,
    updates: { url?: string; events?: string[]; is_active?: boolean }
  ): Promise<Webhook> {
    return this.request<Webhook>('PATCH', `/webhooks/${webhookId}`, updates);
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(webhookId: number): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('DELETE', `/webhooks/${webhookId}`);
  }

  /**
   * Rotate webhook secret
   */
  async rotateWebhookSecret(webhookId: number): Promise<Webhook> {
    return this.request<Webhook>('POST', `/webhooks/${webhookId}/rotate-secret`);
  }
}

/**
 * Custom error class for Barevalue API errors
 */
export class BarevalueApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'BarevalueApiError';
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}
