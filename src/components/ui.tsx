import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AppStatus } from '../types';
import { useI18n } from '../lib/i18n';

/* -------------------------------------------------------------------------- */
/* Toasts                                                                     */
/* -------------------------------------------------------------------------- */

type ToastKind = 'ok' | 'err' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  push: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    counter.current += 1;
    const id = counter.current;
    setItems((prev) => [...prev, { id, kind, message }].slice(-3));
    window.setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, 4600);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            className={`toast ${item.kind === 'ok' ? 'ok' : item.kind === 'err' ? 'err' : ''}`}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* -------------------------------------------------------------------------- */
/* Status pill                                                                */
/* -------------------------------------------------------------------------- */

const STATUS_CLASS: Record<AppStatus, string> = {
  up: 'up',
  down: 'down',
  recovering: 'recovering',
  paused: 'paused',
  unknown: 'unknown',
};

export function StatusPill({ status, live = false }: { status: AppStatus; live?: boolean }) {
  const { t } = useI18n();
  return (
    <span
      className={`pill ${STATUS_CLASS[status]} ${live && status === 'up' ? 'pill-live' : ''}`}
      title={
        status === 'unknown'
          ? t('status.unknownHint')
          : status === 'paused'
            ? t('status.pausedHint')
            : undefined
      }
    >
      {t(`status.${status}` as 'status.up')}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Modal                                                                      */
/* -------------------------------------------------------------------------- */

export function Modal({
  title,
  children,
  onClose,
  footer,
  subtitle,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const { t } = useI18n();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = original;
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div>
            <h2 style={{ fontSize: 16 }}>{title}</h2>
            {subtitle ? (
              <p className="small muted" style={{ margin: '3px 0 0' }}>
                {subtitle}
              </p>
            ) : null}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Confirm dialog                                                             */
/* -------------------------------------------------------------------------- */

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <span className="spinner" /> : (confirmLabel ?? t('common.save'))}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13.5 }}>{message}</p>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty / error / loading states                                             */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="panel panel-pad" role="alert">
      <div className="form-error">
        <span aria-hidden="true">⚠</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 620, marginBottom: 2 }}>{t('common.couldNotLoad')}</div>
          <div>{message}</div>
        </div>
      </div>
      {onRetry ? (
        <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={onRetry}>
          {t('common.retry')}
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: string }) {
  return <div className="skeleton" style={{ height, width }} />;
}

export function LoadingPanel({ rows = 3 }: { rows?: number }) {
  return (
    <div className="panel panel-pad stack" aria-busy="true" aria-live="polite">
      <Skeleton height={14} width="34%" />
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} height={44} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Field wrapper                                                              */
/* -------------------------------------------------------------------------- */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <span className="hint" style={{ color: 'var(--down)' }} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}
