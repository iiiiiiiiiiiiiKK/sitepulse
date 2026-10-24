export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_NAME?: string;
  ENVIRONMENT?: string;
  PROBES_PER_RUN?: string;
  REQUIRE_EMAIL_VERIFICATION?: string;
  PUBLIC_BASE_URL?: string;
  ENCRYPTION_KEY?: string;
  AUTH_PEPPER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_API_URL?: string;
};

export type MonitorStatus = 'unknown' | 'up' | 'down' | 'paused';
export type ErrorKind =
  | 'status'
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'connection'
  | 'redirect'
  | 'blocked'
  | 'protocol'
  | 'network';

export interface MonitorRow {
  id: string;
  user_id: string;
  name: string;
  url: string;
  method: string;
  interval_seconds: number;
  timeout_ms: number;
  expected_status: string;
  failure_threshold: number;
  recovery_threshold: number;
  status: MonitorStatus;
  enabled: number;
  is_public: number;
  public_slug: string;
  consecutive_failures: number;
  consecutive_successes: number;
  next_check_at: number;
  last_check_at: number | null;
  last_success_at: number | null;
  last_status_code: number | null;
  last_response_ms: number | null;
  last_error: string | null;
  last_error_kind: string | null;
  current_incident_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserRow {
  id: string;
  email: string;
  email_norm: string;
  password_hash: string;
  password_salt: string;
  password_iters: number;
  plan: string;
  email_verified: number;
  created_at: number;
  last_login_at: number | null;
}

export interface IncidentRow {
  id: string;
  monitor_id: string;
  started_at: number;
  resolved_at: number | null;
  duration_seconds: number | null;
  cause: string | null;
  summary: string | null;
  last_status_code: number | null;
  peak_response_ms: number | null;
  notified_start: number;
  notified_resolve: number;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  monitor_id: string | null;
  kind: 'webhook' | 'email';
  target: string;
  secret_enc: string | null;
  enabled: number;
  on_down: number;
  on_recover: number;
  created_at: number;
}

export interface ProbeResult {
  ok: boolean;
  statusCode: number | null;
  responseMs: number | null;
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  redirects: number;
  finalUrl: string | null;
}

export interface ProbeTarget {
  url: string;
  method: string;
  timeoutMs: number;
  expectedStatus: string;
}
