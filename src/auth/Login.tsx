import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { User } from '../../shared/types';
import { api } from '../api';
import { EyeIcon, EyeOffIcon, WalletIcon } from '../components/Icons';
import { cleanError } from '../format';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }): void;
          renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
        };
      };
    };
  }
}

// `mode` is driven by the route (/login, /register, /forgot-password); switching
// between them navigates rather than flipping local state, so each is its own URL.
export function Login({
  mode,
  googleClientId,
  onAuthed,
}: {
  mode: 'signin' | 'register' | 'forgot';
  googleClientId: string;
  onAuthed: (user: User) => void;
}) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const googleDiv = useRef<HTMLDivElement>(null);

  // Clear transient state whenever the route (mode) changes.
  useEffect(() => {
    setError('');
    setForgotSent(false);
  }, [mode]);

  // Keep latest callbacks in refs so the GIS effect runs exactly once.
  const onAuthedRef = useRef(onAuthed);
  onAuthedRef.current = onAuthed;

  useEffect(() => {
    if (!googleClientId) return;
    let cancelled = false;

    const init = () => {
      if (cancelled || !window.google || !googleDiv.current) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (response) => {
          try {
            const r = await api.auth.google(response.credential);
            onAuthedRef.current(r.user);
          } catch (err) {
            setError(cleanError(err));
          }
        },
      });
      googleDiv.current.innerHTML = '';
      window.google.accounts.id.renderButton(googleDiv.current, {
        theme: 'filled_black',
        size: 'large',
        width: 320,
        text: 'continue_with',
        shape: 'pill',
      });
    };

    if (window.google) {
      init();
    } else {
      const existing = document.querySelector<HTMLScriptElement>('script[data-gsi]');
      if (existing) {
        existing.addEventListener('load', init);
      } else {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.dataset.gsi = '1';
        script.onload = init;
        document.head.appendChild(script);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [googleClientId, mode]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const em = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      setError('Enter a valid email address');
      return;
    }
    if (mode === 'forgot') {
      setBusy(true);
      try {
        await api.auth.forgot(em);
        setForgotSent(true);
      } catch (err) {
        setError(cleanError(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (mode === 'register' && password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (!password) {
      setError('Enter your password');
      return;
    }
    setBusy(true);
    try {
      const r =
        mode === 'signin'
          ? await api.auth.login(em, password)
          : await api.auth.register(em, password, name.trim());
      onAuthed(r.user);
    } catch (err) {
      setError(cleanError(err));
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">
          <span className="logo-badge logo-badge-lg">
            <WalletIcon size={22} />
          </span>
          <div>
            <div className="login-title">SpendTracker</div>
            <div className="login-sub">Budgets, spending and income — in one place</div>
          </div>
        </div>

        {mode !== 'forgot' && (
          <div className="login-tabs">
            <button
              className={mode === 'signin' ? 'active' : ''}
              onClick={() => navigate('/login')}
              type="button"
            >
              Sign in
            </button>
            <button
              className={mode === 'register' ? 'active' : ''}
              onClick={() => navigate('/register')}
              type="button"
            >
              Create account
            </button>
          </div>
        )}

        {mode === 'forgot' ? (
          forgotSent ? (
            <div className="form-grid">
              <div className="notice notice-block">
                If an account exists for <strong>{email.trim()}</strong>, we've sent a password
                reset link. Check your inbox (and spam folder) — the link expires in 1 hour.
              </div>
              <button type="button" className="btn btn-block" onClick={() => navigate('/login')}>
                Back to sign in
              </button>
            </div>
          ) : (
            <form className="form-grid" onSubmit={submit}>
              <div className="forgot-intro">
                Enter your account email and we'll send you a link to reset your password.
              </div>
              <div className="field">
                <label htmlFor="login-email">Email</label>
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                />
              </div>
              {error && <div className="form-error">{error}</div>}
              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
              <button type="button" className="link-btn" onClick={() => navigate('/login')}>
                Back to sign in
              </button>
            </form>
          )
        ) : (
          <>
            <form className="form-grid" onSubmit={submit}>
              {mode === 'register' && (
                <div className="field">
                  <label htmlFor="login-name">Name (optional)</label>
                  <input
                    id="login-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    maxLength={100}
                    autoComplete="name"
                  />
                </div>
              )}
              <div className="field">
                <label htmlFor="login-email">Email</label>
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                />
              </div>
              <div className="field">
                <div className="field-label-row">
                  <label htmlFor="login-password">Password</label>
                  {mode === 'signin' && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => navigate('/forgot-password')}
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <div className="input-with-affix">
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  />
                  <button
                    type="button"
                    className="input-affix-btn"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    title={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>

              {error && <div className="form-error">{error}</div>}

              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            </form>

            {googleClientId && (
              <>
                <div className="login-divider">
                  <span>or</span>
                </div>
                <div className="google-btn-wrap" ref={googleDiv} />
              </>
            )}
          </>
        )}

        <div className="login-foot">
          Your data is private to your account only.
        </div>
      </div>
    </div>
  );
}
