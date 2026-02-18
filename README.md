# barevalue-mcp

MCP (Model Context Protocol) server for the [Barevalue](https://barevalue.com) AI podcast editing API. Allows Claude Code and other MCP-compatible tools to submit and manage podcast editing orders programmatically.

## Features

- **Upload audio files** directly from your local machine
- **Submit orders** for AI-powered podcast editing
- **Check order status** and download completed files
- **Manage webhooks** for automated notifications
- **Pre-validate URLs** before submission to catch issues early

## Prerequisites

**You need a Barevalue account** to submit orders via MCP. The **Basic plan is free** and includes minutes and orders each month. Paid plans (Starter, Creator, Pro) include more minutes, more orders, and additional features.

Orders use your subscription minutes. If your account has insufficient minutes, submission will fail with `insufficient_credits` error.

**To get started:**
- Sign up free at [barevalue.com/register](https://barevalue.com/register)
- Or view plans at [barevalue.com/pricing](https://barevalue.com/pricing)

## Installation

### Option 1: npx (Recommended)

No installation required. Configure Claude Code to run via npx:

```json
{
  "mcpServers": {
    "barevalue": {
      "command": "npx",
      "args": ["-y", "barevalue-mcp"],
      "env": {
        "BAREVALUE_API_KEY": "bv_sk_your_api_key_here"
      }
    }
  }
}
```

### Option 2: Global Install

```bash
npm install -g barevalue-mcp
```

Then configure Claude Code:

```json
{
  "mcpServers": {
    "barevalue": {
      "command": "barevalue-mcp",
      "env": {
        "BAREVALUE_API_KEY": "bv_sk_your_api_key_here"
      }
    }
  }
}
```

## Configuration

### Getting an API Key

1. Log in to your [Barevalue account](https://barevalue.com/login)
2. Navigate to **Settings** → **API Keys**
3. Click **Create API Key**
4. Copy the key (starts with `bv_sk_`) — it's only shown once!

### Claude Code Setup

Add to your Claude Code settings file (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "barevalue": {
      "command": "npx",
      "args": ["-y", "barevalue-mcp"],
      "env": {
        "BAREVALUE_API_KEY": "bv_sk_your_api_key_here"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BAREVALUE_API_KEY` | Yes | Your Barevalue API key (starts with `bv_sk_`) |
| `BAREVALUE_API_URL` | No | Override API base URL (default: `https://barevalue.com/api/v1`) |

## Available Tools

### Account & Billing

#### `barevalue_account`
Get account information including credit balance, AI subscription status, and pricing.

```
barevalue_account
```

#### `barevalue_estimate`
Calculate the cost of an order before submission.

```
barevalue_estimate duration_minutes=45
```

### Order Workflow

#### `barevalue_upload`
Upload an audio file from your local machine. Returns `order_id` and `s3_key` for submission.

```
barevalue_upload file_path="/path/to/episode.mp3"
```

**Supported formats:** mp3, wav, m4a, flac, aac, ogg
**Maximum file size:** 750MB

#### `barevalue_validate`
Pre-check a file from a public URL before submission. Validates speech content (minimum 10%) and detects music-only content. Does NOT charge credits.

**Note:** This is for external URLs only. Files uploaded via `barevalue_upload` don't need validation - go directly to `barevalue_submit`.

```
barevalue_validate file_url="https://example.com/episode.mp3"
```

#### `barevalue_submit`
Submit an uploaded file for AI editing. Charges credits/subscription minutes.

```
barevalue_submit \
  order_id=12345 \
  s3_key="123/12345/raw/episode.mp3" \
  podcast_name="My Podcast" \
  episode_name="Episode 42: The Answer" \
  processing_style="standard"
```

**Optional parameters:**
- `episode_number` - Episode number for organization
- `special_instructions` - Custom editing instructions (max 2000 chars)
- `processing_style` - `standard` | `minimal` | `aggressive`
- `host_names` - Array of host names for transcript speaker labels
- `guest_names` - Array of guest names for transcript speaker labels

#### `barevalue_submit_url`
Submit using a public URL instead of uploading.

```
barevalue_submit_url \
  file_url="https://example.com/episode.mp3" \
  podcast_name="My Podcast" \
  episode_name="Episode 42"
```

#### `barevalue_status`
Check order status. Returns download URLs when complete.

```
barevalue_status order_id=12345
```

**Statuses:** `pending`, `downloading`, `processing`, `transcribing`, `editing`, `completed`, `failed`, `refunded`

#### `barevalue_list_orders`
List recent orders with pagination.

```
barevalue_list_orders page=1 per_page=20 status="completed"
```

### Webhooks

#### `barevalue_webhooks_list`
List all configured webhooks.

#### `barevalue_webhook_create`
Create a webhook. **Save the secret — it's only shown once!**

```
barevalue_webhook_create \
  url="https://your-server.com/webhook" \
  events=["order.completed", "order.failed"]
```

**Available events:** `order.completed`, `order.failed`, `order.refunded`

#### `barevalue_webhook_update`
Update webhook URL, events, or active status.

```
barevalue_webhook_update webhook_id=1 is_active=false
```

#### `barevalue_webhook_delete`
Delete a webhook permanently.

```
barevalue_webhook_delete webhook_id=1
```

#### `barevalue_webhook_rotate_secret`
Generate a new signing secret. Old secret stops working immediately.

```
barevalue_webhook_rotate_secret webhook_id=1
```

## Usage Examples

### Complete Workflow (Local File)

Here's a typical workflow for uploading a local file:

```
User: Upload and edit my podcast episode at /Users/me/recording.mp3

Claude: I'll help you submit that podcast episode for editing.

1. First, let me check your account balance...
   [calls barevalue_account]
   You have 120 AI minutes remaining on your subscription.

2. Uploading the file...
   [calls barevalue_upload file_path="/Users/me/recording.mp3"]
   Upload complete. Order ID: 12345

3. Submitting for editing...
   [calls barevalue_submit order_id=12345 s3_key="..." podcast_name="My Show" episode_name="Episode 1"]
   Order submitted! Estimated completion: 15 minutes.

4. I'll check the status...
   [calls barevalue_status order_id=12345]
   Status: completed

   Download links:
   - Edited audio: https://...
   - Transcript PDF: https://...
   - Show notes: https://...
```

### Complete Workflow (External URL)

For files already hosted online, you can validate before submitting:

```
User: Edit this podcast: https://example.com/episode.mp3

Claude: I'll validate and submit that for editing.

1. Checking your account...
   [calls barevalue_account]
   You have 50 AI bonus minutes available.

2. Validating the file...
   [calls barevalue_validate file_url="https://example.com/episode.mp3"]
   ✓ Speech detected: 87%
   ✓ No music-only content detected
   Duration: 32 minutes

3. Submitting for editing...
   [calls barevalue_submit_url file_url="..." podcast_name="My Show" episode_name="Episode 5"]
   Order submitted! Order ID: 12346
```

### Checking Multiple Orders

```
User: What's the status of my recent orders?

Claude: [calls barevalue_list_orders per_page=5]

Here are your recent orders:
| Order ID | Episode | Status | Created |
|----------|---------|--------|---------|
| 12345 | Episode 42 | completed | 2 hours ago |
| 12344 | Episode 41 | completed | yesterday |
| 12343 | Episode 40 | processing | just now |
```

## Error Handling

The server returns structured errors:

```json
{
  "error": "insufficient_credits",
  "message": "Not enough credits. Need $3.15, have $2.00",
  "statusCode": 402
}
```

Common errors:

| Error | Meaning |
|-------|---------|
| `invalid_api_key` | API key is missing, invalid, or revoked |
| `insufficient_credits` | Not enough credits or subscription minutes |
| `validation_failed` | File failed pre-checks (not enough speech, music detected) |
| `file_too_large` | File exceeds 750MB limit |
| `rate_limited` | Too many requests (limit: 10/minute) |

## Pricing

MCP orders use your subscription minutes — the same balance you'd use on barevalue.com. The **Basic plan is free** and includes minutes and orders each month. Paid plans include more minutes, orders, and features.

**What's included with every order:**
- Edited audio file (filler words, long pauses, false starts removed)
- Transcript (PDF and DOCX)
- Show notes with timestamps
- Social media clips (AI-selected highlights)

Use `barevalue_estimate` to check your available minutes before submitting. View plans at [barevalue.com/pricing](https://barevalue.com/pricing).

## Rate Limits

- **10 requests per minute** per API key
- File uploads have a 5-minute timeout
- Order processing typically completes in 10-30 minutes

## Security

- API keys are transmitted via environment variable, never hardcoded
- All API communication uses HTTPS
- Webhook signatures use HMAC-SHA256 for verification
- Presigned S3 URLs expire after 30 minutes

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev
```

## Support

- **Documentation:** https://barevalue.com/docs/api-v1
- **Email:** support@barevalue.com

## License

MIT
