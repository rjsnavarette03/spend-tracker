import { FormEvent, useState } from 'react';
import type { User } from '../../shared/types';
import { api } from '../api';
import { cleanError } from '../format';
import { EyeIcon, EyeOffIcon } from './Icons';
import { Modal } from './Modal';

// Curated list; the server accepts any valid 3-letter code and the formatter
// falls back gracefully, so this can grow freely.
const CURRENCIES: Array<[string, string]> = [
  ['USD', '$ USD — US Dollar'],
  ['PHP', '₱ PHP — Philippine Peso'],
  ['EUR', '€ EUR — Euro'],
  ['GBP', '£ GBP — British Pound'],
  ['JPY', '¥ JPY — Japanese Yen'],
  ['AUD', 'A$ AUD — Australian Dollar'],
  ['CAD', 'C$ CAD — Canadian Dollar'],
  ['SGD', 'S$ SGD — Singapore Dollar'],
  ['HKD', 'HK$ HKD — Hong Kong Dollar'],
  ['INR', '₹ INR — Indian Rupee'],
  ['CNY', '¥ CNY — Chinese Yuan'],
  ['MYR', 'RM MYR — Malaysian Ringgit'],
  ['THB', '฿ THB — Thai Baht'],
  ['IDR', 'Rp IDR — Indonesian Rupiah'],
  ['VND', '₫ VND — Vietnamese Dong'],
  ['KRW', '₩ KRW — South Korean Won'],
  ['AED', 'AED — UAE Dirham'],
  ['NZD', 'NZ$ NZD — New Zealand Dollar'],
  ['CHF', 'CHF — Swiss Franc'],
  ['TWD', 'NT$ TWD — Taiwan Dollar'],
];

function previewAmount(code: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(1234.56);
  } catch {
    return code;
  }
}

export function AccountModal({
  user,
  onClose,
  onChanged,
}: {
  user: User;
  onClose: () => void;
  onChanged: () => void;
}) {
  // Google-only accounts have no password yet — this becomes "set a password".
  const needsCurrent = user.hasPassword;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // Currency preference (applies immediately on change).
  const [currency, setCurrencyChoice] = useState((user.currency || 'USD').toUpperCase());
  const [curBusy, setCurBusy] = useState(false);
  const [curSaved, setCurSaved] = useState(false);
  const [curError, setCurError] = useState('');
  // Ensure the current code is always selectable even if not in the list.
  const options = CURRENCIES.some(([c]) => c === currency)
    ? CURRENCIES
    : [[currency, `${currency}`] as [string, string], ...CURRENCIES];

  const changeCurrency = async (code: string) => {
    const prev = currency;
    setCurError('');
    setCurSaved(false);
    setCurrencyChoice(code);
    setCurBusy(true);
    try {
      await api.auth.setCurrency(code);
      setCurSaved(true);
      onChanged(); // re-render the app so all amounts reformat
    } catch (err) {
      setCurrencyChoice(prev); // revert on failure
      setCurError(cleanError(err));
    } finally {
      setCurBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (next.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }
    if (next !== confirm) {
      setError('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api.auth.changePassword(needsCurrent ? current : '', next);
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged();
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Account" onClose={onClose}>
      <div className="account-head">
        <div className="account-avatar">{(user.name || user.email).charAt(0).toUpperCase()}</div>
        <div className="account-id">
          {user.name && <div className="account-name">{user.name}</div>}
          <div className="account-email">{user.email}</div>
          <div className="account-methods">
            {user.hasPassword && <span className="type-tag income">Password</span>}
            {user.hasGoogle && <span className="type-tag expense">Google</span>}
          </div>
        </div>
      </div>

      <div className="account-section-title">Currency</div>
      <div className="field">
        <label htmlFor="acct-currency">Display currency</label>
        <select
          id="acct-currency"
          value={currency}
          onChange={(e) => changeCurrency(e.target.value)}
          disabled={curBusy}
        >
          {options.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        <div className="field-hint">
          Example: {previewAmount(currency)} · changes how all amounts display.
        </div>
        {curError && <div className="form-error">{curError}</div>}
        {curSaved && !curError && <div className="notice notice-block">Currency updated.</div>}
      </div>

      <div className="account-section-title">{needsCurrent ? 'Change password' : 'Set a password'}</div>
      {!needsCurrent && (
        <div className="forgot-intro" style={{ marginBottom: 12 }}>
          Your account uses Google sign-in. Set a password to also sign in with email.
        </div>
      )}

      <form className="form-grid" onSubmit={submit}>
        {needsCurrent && (
          <div className="field">
            <label htmlFor="acct-current">Current password</label>
            <input
              id="acct-current"
              type={show ? 'text' : 'password'}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="acct-new">New password</label>
          <div className="input-with-affix">
            <input
              id="acct-new"
              type={show ? 'text' : 'password'}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              autoFocus={!needsCurrent}
            />
            <button
              type="button"
              className="input-affix-btn"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? 'Hide password' : 'Show password'}
              aria-pressed={show}
              title={show ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              {show ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="acct-confirm">Confirm new password</label>
          <input
            id="acct-confirm"
            type={show ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </div>

        {error && <div className="form-error">{error}</div>}
        {done && <div className="notice notice-block">Password updated.</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : needsCurrent ? 'Update password' : 'Set password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
