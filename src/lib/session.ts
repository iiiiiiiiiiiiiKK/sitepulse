import { useSyncExternalStore } from 'react';
import { api } from '../api';
import type { User } from '../types';

/**
 * Session bootstrap: one `/api/auth/me` call on first load decides whether the
 * app renders the dashboard or the login screen. There is no optimistic
 * "logged in" state, so a stale cookie can never show an empty dashboard.
 */

export interface SessionState {
  status: 'loading' | 'anonymous' | 'authenticated';
  user: User | null;
  error: string | null;
}

let state: SessionState = { status: 'loading', user: null, error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function emit(next: SessionState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

export function refreshSession(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const result = await api.me();
      emit({ status: 'authenticated', user: result.user, error: null });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401) {
        emit({ status: 'anonymous', user: null, error: null });
      } else {
        emit({
          status: 'anonymous',
          user: null,
          error: error instanceof Error ? error.message : 'Could not reach the API.',
        });
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function setSessionUser(user: User) {
  emit({ status: 'authenticated', user, error: null });
}

export function signOutLocal() {
  emit({ status: 'anonymous', user: null, error: null });
}

/** Triggers the initial fetch once, then keeps the component subscribed. */
export function useSession(): SessionState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (snapshot.status === 'loading' && !inflight) {
    void refreshSession();
  }
  return snapshot;
}
