import { FormEvent, useEffect, useRef, useState } from 'react';
import type { User } from '../../shared/types';
import { api } from '../api';
import { WalletIcon } from '../components/Icons';
import { ThemeToggle } from '../components/ThemeToggle';
import { cleanError } from '../format';

const RESEND_COOLDOWN = 30; // seconds

// In-flight/settled verify-link attempts, keyed by token. The token is
// single-use, so React 18 StrictMode's dev double-mount must not fire two
// POSTs (the second would 400 on the consumed token). Module-scoped so it
// survives the dev unmount/remount; both mounts attach handlers to the one
// shared promise, so success and failure are both reported by the live mount.
const verifyLinkAttempts = new Map<string, ReturnType<typeof api.auth.verifyLink>>();

// Two jobs, chosen by `mode`:
//  - 'code': the signed-in-but-unverified screen — type the 6-digit code (or
//    use the emailed link) to unlock the app.
//  - 'link': process a ?verify=<token> backup link on mount, then hand off the
//    (now signed-in) user. Works even with no prior session.
export function VerifyEmail({
  mode,
  token,
  email,
  onDone,
  onCancel,
  onSignOut,
}: {
  mode: 'code' | 'link';
  token?: string;
  email?: string;
  onDone: (user: User) => void;
  onCancel?: () => void; // link mode: give up, back to sign in
  onSignOut?: () => void; // code mode: sign out / use a different account
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [linkFailed, setLinkFailed] = useState(false);

  // Keep the latest onDone so the link-verify effect can run exactly once.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // Link mode: redeem the token as soon as the screen mounts. Fire the request
  // once per token (shared promise) but let each mount attach its own handlers,
  // so a StrictMode double-mount still reports the result on the live mount.
  useEffect(() => {
    if (mode !== 'link' || !token) return;
    let cancelled = false;
    let attempt = verifyLinkAttempts.get(token);
    if (!attempt) {
      attempt = api.auth.verifyLink(token);
      verifyLinkAttempts.set(token, attempt);
    }
    attempt.then(
      (r) => {
        if (!cancelled) onDoneRef.current(r.user);
      },
      (err) => {
        if (!cancelled) {
          setError(cleanError(err));
          setLinkFailed(true);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [mode, token]);

  // Resend cooldown ticker.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your email');
      return;
    }
    setBusy(true);
    try {
      const r = await api.auth.verify(code);
      onDone(r.user);
    } catch (err) {
      setError(cleanError(err));
      setBusy(false);
    }
  };

  const resend = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await api.auth.resendVerification();
      setNotice('We sent a new code to your email.');
      setCooldown(RESEND_COOLDOWN);
      setCode('');
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'link') {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-logo">
            <span className="logo-badge logo-badge-lg">
              <WalletIcon size={22} />
            </span>
            <div>
              <div className="login-title">
                {linkFailed ? "Couldn't verify this link" : 'Verifying your email…'}
              </div>
              <div className="login-sub">
                {linkFailed
                  ? 'The link may have expired or already been used.'
                  : 'One moment while we confirm your account.'}
              </div>
            </div>
          </div>
          {linkFailed ? (
            <div className="form-grid">
              {error && <div className="form-error" role="alert">{error}</div>}
              <button type="button" className="btn btn-primary btn-block" onClick={onCancel}>
                Back to sign in
              </button>
            </div>
          ) : (
            <div className="notice notice-block">Verifying…</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <ThemeToggle className="btn-icon login-theme-toggle" />
        <div className="login-logo">
          <span className="logo-badge logo-badge-lg">
            <WalletIcon size={22} />
          </span>
          <div>
            <div className="login-title">Verify your email</div>
            <div className="login-sub">Confirm it's you to start using SpendTracker</div>
          </div>
        </div>

        <form className="form-grid" onSubmit={submit}>
          <div className="verify-intro">
            We sent a 6-digit code{email ? <> to <strong>{email}</strong></> : ''}. Enter it below to
            verify your account.
          </div>
          <div className="field">
            <label htmlFor="verify-code">Verification code</label>
            <input
              id="verify-code"
              className="verify-code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              autoFocus
            />
          </div>

          {error && <div className="form-error" role="alert">{error}</div>}
          {notice && <div className="notice notice-block">{notice}</div>}

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={busy || code.length !== 6}
          >
            {busy ? 'Verifying…' : 'Verify email'}
          </button>
        </form>

        <div className="verify-resend">
          Didn't get the email?{' '}
          <button type="button" className="link-btn" onClick={resend} disabled={busy || cooldown > 0}>
            {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
          </button>
        </div>

        <div className="verify-hint">
          The email also includes a one-click verification link. For your security, never share your
          code — we'll never ask for it by phone or message.
        </div>

        {onSignOut && (
          <div className="login-foot">
            <button type="button" className="link-btn" onClick={onSignOut}>
              Sign out / use a different account
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
