import { useSyncExternalStore } from 'react';
import { Modal } from './Modal';

// Lightweight, dependency-free replacements for window.alert / window.confirm:
//   toast.error('...')            -> transient notification (auto-dismisses)
//   const ok = await confirm({…}) -> styled promise-based confirmation dialog
//
// State lives in a tiny module-level store; a single <UiHost/> (mounted once at
// the app root) subscribes via useSyncExternalStore. No polling, no library, so
// there's no runtime/perf cost when nothing is on screen.

export type ToastKind = 'error' | 'success' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmItem extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

let version = 0;
let toastsState: ToastItem[] = [];
let confirmState: ConfirmItem | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  version += 1;
  listeners.forEach((l) => l());
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function getVersion() {
  return version;
}

function dismissToast(id: number) {
  toastsState = toastsState.filter((t) => t.id !== id);
  emit();
}

function pushToast(kind: ToastKind, message: string, ms: number): number {
  const id = (seq += 1);
  toastsState = [...toastsState, { id, kind, message }];
  emit();
  if (ms > 0) window.setTimeout(() => dismissToast(id), ms);
  return id;
}

export const toast = {
  error: (message: string) => pushToast('error', message, 6000),
  success: (message: string) => pushToast('success', message, 3500),
  info: (message: string) => pushToast('info', message, 4000),
};

/** Promise-based replacement for window.confirm(); resolves true on confirm. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  // Resolve any dialog already open (shouldn't normally happen) before replacing.
  if (confirmState) confirmState.resolve(false);
  return new Promise<boolean>((resolve) => {
    confirmState = { resolve, ...options };
    emit();
  });
}

function settleConfirm(ok: boolean) {
  const current = confirmState;
  if (!current) return;
  confirmState = null;
  emit();
  current.resolve(ok);
}

export function UiHost() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const toasts = toastsState;
  const dialog = confirmState;

  return (
    <>
      {toasts.length > 0 && (
        <div className="toast-container" role="region" aria-label="Notifications">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`} role="status">
              <span className="toast-message">{t.message}</span>
              <button
                type="button"
                className="toast-close"
                aria-label="Dismiss"
                onClick={() => dismissToast(t.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {dialog && (
        <Modal title={dialog.title ?? 'Are you sure?'} onClose={() => settleConfirm(false)}>
          <div className="confirm-dialog">
            <p className="confirm-message">{dialog.message}</p>
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => settleConfirm(false)}>
                {dialog.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                className={`btn ${dialog.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => settleConfirm(true)}
                autoFocus
              >
                {dialog.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
