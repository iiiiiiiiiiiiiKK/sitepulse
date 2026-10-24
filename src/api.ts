/**
 * Typed API client.
 *
 * Every call goes through `request()`, which:
 *  - sends the session cookie (`credentials: 'include'`) — no tokens in JS memory
 *  - normalises error shapes into `ApiClientError` with the server message
 *  - distinguishes network failure / timeout / HTTP error so the UI can show an
 *    honest message instead of a generic "something went wrong"
 */

export class ApiClientError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class NetworkError extends Error {
  constructor(message = 'Cannot reach the SitePulse API. Check your connection and retry.') {
    super(message);
    this.name = 'NetworkError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 20000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'include',
      ...rest,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(rest.body ? { 'content-type': 'application/json' } : {}),
        ...(rest.headers ?? {}),
      },
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new NetworkError('The request timed out. The server may be busy — try again.');
    }
    throw new NetworkError();
  }
  clearTimeout(timer);

  if (response.status === 204) return {} as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const errorBody = payload as { error?: { message?: string; code?: string } } | null;
    throw new ApiClientError(
      response.status,
      errorBody?.error?.message ?? `Request failed with HTTP ${response.status}.`,
      errorBody?.error?.code ?? 'error'
    );
  }
  return (payload ?? {}) as T;
}

import type {
  AccountSummary,
  Channel,
  Delivery,
  Maintenance,
  Monitor,
  MonitorDetail,
  User,
} from './types';

export const api = {
  register: (email: string, password: string) =>
    request<{ user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () =>
    request<{ user: User; usage: { monitors: number; maxMonitors: number } }>('/api/auth/me'),

  summary: () => request<AccountSummary>('/api/account/summary'),

  listMonitors: () =>
    request<{
      monitors: Monitor[];
      quota: { used: number; max: number; plan: string };
    }>('/api/monitors'),

  createMonitor: (input: {
    name: string;
    url: string;
    method: string;
    intervalSeconds: number;
    timeoutMs: number;
    expectedStatus: string;
    failureThreshold: number;
    recoveryThreshold: number;
  }) =>
    request<{ monitor: Monitor }>('/api/monitors', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  getMonitor: (id: string, range: string) =>
    request<MonitorDetail>(`/api/monitors/${id}?range=${range}`),

  updateMonitor: (id: string, patch: Record<string, unknown>) =>
    request<{ monitor: Monitor }>(`/api/monitors/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteMonitor: (id: string) =>
    request<{ ok: boolean }>(`/api/monitors/${id}`, { method: 'DELETE' }),

  pauseMonitor: (id: string) =>
    request<{ monitor: Monitor }>(`/api/monitors/${id}/pause`, { method: 'POST' }),

  resumeMonitor: (id: string) =>
    request<{ monitor: Monitor }>(`/api/monitors/${id}/resume`, { method: 'POST' }),

  checkNow: (id: string) =>
    request<{ ok: boolean; queued: boolean; message: string }>(
      `/api/monitors/${id}/check-now`,
      { method: 'POST' }
    ),

  testMonitorNotifications: (id: string) =>
    request<{
      outcomes: Array<{ notificationId: string; kind: string; status: string; detail: string }>;
      summary: { sent: number; failed: number; skipped: number; message: string };
    }>(`/api/monitors/${id}/test-notification`, { method: 'POST' }),

  exportUrl: (id: string, format: 'csv' | 'json', range: string) =>
    `/api/monitors/${id}/export?format=${format}&range=${range}`,

  listChannels: () =>
    request<{
      channels: Channel[];
      recentDeliveries: Delivery[];
      emailConfigured: boolean;
    }>('/api/notifications'),

  createChannel: (input: {
    kind: 'webhook' | 'email';
    target: string;
    monitorId?: string | null;
    secret?: string;
    onDown?: boolean;
    onRecover?: boolean;
  }) =>
    request<{ channel: Channel; warning: string | null }>('/api/notifications', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateChannel: (id: string, patch: Record<string, unknown>) =>
    request<{ channel: Channel }>(`/api/notifications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteChannel: (id: string) =>
    request<{ ok: boolean }>(`/api/notifications/${id}`, { method: 'DELETE' }),

  testChannel: (id: string) =>
    request<{ outcomes: Array<{ status: string; detail: string }> }>(
      `/api/notifications/${id}/test`,
      { method: 'POST' }
    ),

  listMaintenance: () => request<{ maintenance: Maintenance[] }>('/api/maintenance'),

  createMaintenance: (input: {
    title: string;
    body: string;
    startsAt: number;
    endsAt: number;
  }) =>
    request<{ maintenance: Maintenance }>('/api/maintenance', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteMaintenance: (id: string) =>
    request<{ ok: boolean }>(`/api/maintenance/${id}`, { method: 'DELETE' }),
};
