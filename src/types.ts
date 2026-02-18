/**
 * Barevalue MCP Server - Type Definitions
 */

// API Response Types

export interface AccountInfo {
  user: {
    id: number;
    email: string;
    name: string | null;
    is_verified: boolean;
    locale: string;
  };
  credits: {
    balance: number;
    currency: string;
  };
  ai_subscription: {
    tier: string | null;
    status: string | null;
    minutes_limit: number | null;
    minutes_used: number | null;
    minutes_remaining: number | null;
    period_end: string | null;
    pending_tier: string | null;
  } | null;
  ai_bonus_minutes: {
    balance: number;
    expires_at: string | null;
  };
  pricing: {
    audio_per_minute: number;
    // AI editing uses subscription minutes, not per-minute billing
    currency: string;
  };
}

export interface EstimateResponse {
  duration_minutes: number;
  can_afford: boolean;
  minutes_available: {
    bonus: number;
    student: number;
    subscription: number;
    total: number;
  };
  minutes_applied: {
    bonus: number;
    student: number;
    subscription: number;
    total: number;
  };
  minutes_remaining_after: number;
  subscription_tier: string;
  // Only present if can_afford is false
  minutes_short?: number;
  upgrade_required?: boolean;
  message?: string;
  available_upgrades?: Array<{
    name: string;
    minutes_limit: number;
    price_monthly: number;
  }>;
}

export interface UploadUrlResponse {
  order_id: number;
  upload_url: string;
  s3_key: string;
  expires_in: number;
  max_file_size: number;
  allowed_types: string[];
}

export interface UploadUrlsResponse {
  order_id: number;
  files: Array<{
    filename: string;
    role: string;
    upload_url: string;
    s3_key: string;
    expires_in: number;
  }>;
  max_file_size: number;
}

export interface ValidationResponse {
  valid: boolean;
  duration_minutes: number;
  checks: {
    speech_check?: {
      passed: boolean;
      has_speech: boolean;
    };
    content_check?: {
      passed: boolean;
      is_spoken_content: boolean;
    };
  };
  message?: string; // Only present if valid is false
}

export interface SubmitResponse {
  order_id: number;
  status: string;
  message: string;
  duration_minutes: number;
  cost: {
    ai_bonus_minutes_used: number;
    ai_subscription_minutes_used: number;
    credits_used: number;
    payment_charged: number;
  };
  estimated_completion: string;
}

export interface OrderStatus {
  order_id: number;
  status: 'pending' | 'downloading' | 'processing' | 'transcribing' | 'editing' | 'completed' | 'failed' | 'refunded';
  podcast_name: string;
  episode_name: string;
  episode_number: string | null;
  duration_minutes: number;
  created_at: string;
  completed_at: string | null;
  downloads?: {
    edited_audio: string;
    transcript_pdf: string;
    transcript_docx: string;
    show_notes: string | null;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface OrderListItem {
  order_id: number;
  status: string;
  podcast_name: string;
  episode_name: string;
  duration_minutes: number;
  created_at: string;
  completed_at: string | null;
}

export interface OrderListResponse {
  orders: OrderListItem[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}

export interface Webhook {
  id: number;
  url: string;
  events: string[];
  is_active: boolean;
  failure_count: number;
  last_triggered_at: string | null;
  created_at: string;
  secret?: string; // Only returned on create
}

export interface WebhookListResponse {
  webhooks: Webhook[];
}

export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

// Tool Input Types

export interface EstimateInput {
  duration_minutes: number;
}

export interface UploadInput {
  file_path: string;
  filename?: string;
}

export interface UploadMultiTrackInput {
  files: Array<{
    file_path: string;
    filename?: string;
    role: 'host' | 'guest' | 'intro' | 'outro' | 'music' | 'other';
  }>;
}

export interface ValidateInput {
  file_url: string;
}

export interface SubmitInput {
  order_id: number;
  s3_key: string;
  podcast_name: string;
  episode_name: string;
  episode_number?: string;
  special_instructions?: string;
  processing_style?: 'standard' | 'minimal' | 'aggressive';
  host_names?: string[];
  guest_names?: string[];
}

export interface SubmitExternalUrlInput {
  file_url: string;
  podcast_name: string;
  episode_name: string;
  episode_number?: string;
  special_instructions?: string;
  processing_style?: 'standard' | 'minimal' | 'aggressive';
  host_names?: string[];
  guest_names?: string[];
}

export interface StatusInput {
  order_id: number;
}

export interface ListOrdersInput {
  page?: number;
  per_page?: number;
  status?: string;
}

export interface WebhookCreateInput {
  url: string;
  events: string[];
}

export interface WebhookUpdateInput {
  webhook_id: number;
  url?: string;
  events?: string[];
  is_active?: boolean;
}

export interface WebhookDeleteInput {
  webhook_id: number;
}

export interface WebhookRotateSecretInput {
  webhook_id: number;
}
