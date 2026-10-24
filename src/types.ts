export type AppStatus = 'up' | 'down' | 'recovering' | 'paused' | 'unknown';

export interface Monitor {
  id: string;
  name: string;
  url: string;
  method: 'GET' | 'HEAD';
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: string;
  failureThreshold: number;
  recoveryThreshold: number;
  status: AppStatus;
  statusLabel: string;
  rawStatus: string;
  enabled: boolean;
  isPublic: boolean;
  publicSlug: string;
  publicUrl: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  nextCheckAt: number;
  lastCheckAt: number | null;
  lastSuccessAt: number | null;
  lastStatusCode: number | null;
  lastResponseMs: number | null;
  lastError: string | null;
  lastErrorKind: string | null;
  currentIncidentId: string | null;
  createdAt: number;
  updatedAt: number;
  stats24h?: {
    total: number;
    failed: number;
    availability: number | null;
    avgResponseMs: number | null;
  };
}

export interface Bucket {
  t: number;
  total: number;
  failed: number;
  avgMs: number | null;
  availability: number | null;
}

export interface Incident {
  id: string;
  startedAt: number;
  resolvedAt: number | null;
  durationSeconds: number;
  cause: string | null;
  summary: string | null;
  lastStatusCode: number | null;
  peakResponseMs?: number | null;
}

export interface DayRollup {
  day: number;
  total: number;
  failed: number;
  availability: number | null;
}

export interface MonitorDetail {
  monitor: Monitor;
  range: '24h' | '7d' | '30d';
  stats: {
    totalChecks: number;
    failedChecks: number;
    availability: number | null;
    avgResponseMs: number | null;
    minResponseMs: number | null;
    maxResponseMs: number | null;
    p95ResponseMs: number | null;
    downtimeSeconds: number;
    retentionDays: number;
    retentionLimited: boolean;
  };
  buckets: Bucket[];
  daily: DayRollup[];
  incidents: Incident[];
  recentChecks: Array<{ checkedAt: number; ok: boolean; responseMs: number | null }>;
}

export interface User {
  id: string;
  email: string;
  plan: 'free' | 'pro';
  createdAt: number;
  emailVerified: boolean;
  limits: { maxMonitors: number; minIntervalSeconds: number; retentionDays: number };
}

export interface Channel {
  id: string;
  kind: 'webhook' | 'email';
  target: string;
  monitorId: string | null;
  enabled: boolean;
  onDown: boolean;
  onRecover: boolean;
  hasSecret: boolean;
  secretMask: string | null;
  createdAt: number;
}

export interface Delivery {
  id: string;
  notificationId: string;
  kind: string;
  event: string;
  status: string;
  detail: string | null;
  createdAt: number;
}

export interface Maintenance {
  id: string;
  title: string;
  body: string;
  startsAt: number;
  endsAt: number;
  createdAt?: number;
}

export interface AccountSummary {
  plan: 'free' | 'pro';
  monitors: { total: number; up: number; down: number; paused: number; unknown: number };
  openIncidents: number;
  limits: { maxMonitors: number; minIntervalSeconds: number; retentionDays: number };
}
