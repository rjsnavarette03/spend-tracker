import { FormEvent, useState } from 'react';
import type { User } from '../../shared/types';
import { api } from '../api';
import { EyeIcon, EyeOffIcon, WalletIcon } from '../components/Icons';
import { cleanError } from '../format';

export function ResetPassword({
  token,
  onDone,
  onCancel,
}: {
  token: string;
  onDone: (user: User) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const r = await api.auth.reset(token, password);
      onDone(r.user);
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
            <div className="login-title">Choose a new password</div>
            <div className="login-sub">Enter a new password for your account</div>
          </div>
        </div>

        <form className="form-grid" onSubmit={submit}>
          <div className="field">
            <label htmlFor="reset-password">New password</label>
            <div className="input-with-affix">
              <input
                id="reset-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                autoFocus
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

          <div className="field">
            <label htmlFor="reset-confirm">Confirm new password</label>
            <input
              id="reset-confirm"
              type={showPassword ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter your new password"
              autoComplete="new-password"
            />
          </div>

          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Saving…' : 'Reset password'}
          </button>
          <button type="button" className="link-btn" onClick={onCancel}>
            Back to sign in
          </button>
        </form>
      </div>
    </div>
  );
}
