import { FormEvent, useEffect, useState } from 'react';
import type { User } from '../../shared/types';
import { api } from '../api';
import { toast } from '../components/feedback';
import { EyeIcon, EyeOffIcon } from '../components/Icons';
import { cleanError } from '../format';

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

// Account settings page (/settings): currency and password each live in their
// own card with their own Save button (independent saves), plus a visually
// separated danger zone whose delete flow is progressively disclosed and — for
// accounts with a password — re-confirmed with it.
export function Settings({ user, refreshUser }: { user: User; refreshUser: () => void }) {
  const savedCurrency = (user.currency || 'USD').toUpperCase();
  const needsCurrent = user.hasPassword;

  const [currency, setCurrency] = useState(savedCurrency);
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [currencyError, setCurrencyError] = useState('');

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [show, setShow] = useState(false);
  const [pwError, setPwError] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // Danger zone: the delete confirmation is revealed on demand.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePw, setDeletePw] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Ensure the saved code is always selectable even if not in the list.
  const options = CURRENCIES.some(([c]) => c === savedCurrency)
    ? CURRENCIES
    : [[savedCurrency, savedCurrency] as [string, string], ...CURRENCIES];

  const currencyDirty = currency !== savedCurrency;
  const passwordDirty = next !== '' || confirmPw !== '' || current !== '';
  const dirty = currencyDirty || passwordDirty;

  // Warn before a full-page unload (refresh / close tab) with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const saveCurrency = async () => {
    setCurrencyError('');
    if (!currencyDirty) return;
    setSavingCurrency(true);
    try {
      await api.auth.setCurrency(currency);
      refreshUser();
      toast.success('Currency saved');
    } catch (err) {
      setCurrencyError(cleanError(err));
    } finally {
      setSavingCurrency(false);
    }
  };

  const savePassword = async () => {
    setPwError('');
    if (!passwordDirty) return;
    if (next.length < 8) {
      setPwError('New password must be at least 8 characters');
      return;
    }
    if (next !== confirmPw) {
      setPwError('New passwords do not match');
      return;
    }
    if (needsCurrent && current === '') {
      setPwError('Enter your current password');
      return;
    }
    setSavingPassword(true);
    try {
      await api.auth.changePassword(needsCurrent ? current : '', next);
      setCurrent('');
      setNext('');
      setConfirmPw('');
      refreshUser(); // re-syncs user (and the rotated CSRF token) app-wide
      toast.success('Password saved');
    } catch (err) {
      setPwError(cleanError(err));
    } finally {
      setSavingPassword(false);
    }
  };

  const submitCurrency = (e: FormEvent) => {
    e.preventDefault();
    void saveCurrency();
  };
  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void savePassword();
  };

  const deleteAccount = async () => {
    setDeleteError('');
    if (needsCurrent && deletePw === '') {
      setDeleteError('Enter your password to confirm');
      return;
    }
    setDeleting(true);
    try {
      await api.auth.deleteAccount(needsCurrent ? deletePw : '');
      // The account (and session) are gone — restart from the public landing.
      window.location.assign('/');
    } catch (err) {
      setDeleteError(cleanError(err));
      setDeleting(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-sub">Your account and preferences</div>
        </div>
      </div>

      <div className="settings-grid">
        <div className="panel">
          <div className="account-head" style={{ border: 'none', padding: 0, margin: 0 }}>
            <div className="account-avatar">{(user.name || user.email).charAt(0).toUpperCase()}</div>
            <div className="account-id">
              {user.name && <div className="account-name">{user.name}</div>}
              <div className="account-email">{user.email}</div>
            </div>
          </div>
        </div>

        <form className="panel form-grid" onSubmit={submitCurrency}>
          <div className="panel-title" style={{ marginBottom: 0 }}>
            Currency
          </div>
          <div className="field">
            <label htmlFor="set-currency">Display currency</label>
            <select id="set-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {options.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
            <div className="field-hint">
              Example: {previewAmount(currency)} · changes how all amounts display.
            </div>
          </div>
          {currencyError && <div className="form-error" role="alert">{currencyError}</div>}
          <div className="form-actions">
            {currencyDirty && <span className="unsaved-hint">● Unsaved</span>}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={savingCurrency || !currencyDirty}
            >
              {savingCurrency ? 'Saving…' : 'Save currency'}
            </button>
          </div>
        </form>

        <form className="panel form-grid" onSubmit={submitPassword}>
          <div className="panel-title" style={{ marginBottom: 0 }}>
            {needsCurrent ? 'Change password' : 'Set a password'}
          </div>
          {!needsCurrent && (
            <div className="field-hint">
              Your account uses Google sign-in. Set a password to also sign in with email.
            </div>
          )}
          {needsCurrent && (
            <div className="field">
              <label htmlFor="set-current">Current password</label>
              <input
                id="set-current"
                type={show ? 'text' : 'password'}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="set-new">New password</label>
            <div className="input-with-affix">
              <input
                id="set-new"
                type={show ? 'text' : 'password'}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
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
            <div className="field-hint">Leave blank to keep your current password.</div>
          </div>
          <div className="field">
            <label htmlFor="set-confirm">Confirm new password</label>
            <input
              id="set-confirm"
              type={show ? 'text' : 'password'}
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              autoComplete="new-password"
            />
          </div>

          {pwError && <div className="form-error" role="alert">{pwError}</div>}
          <div className="form-actions">
            {passwordDirty && <span className="unsaved-hint">● Unsaved</span>}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={savingPassword || !passwordDirty}
            >
              {savingPassword ? 'Saving…' : needsCurrent ? 'Change password' : 'Set password'}
            </button>
          </div>
        </form>

        <div className="panel danger-panel">
          <div className="panel-title danger-title">Danger zone</div>
          <p className="danger-text">
            Permanently delete your account and everything in it — accounts, transactions,
            transfers, budgets and categories. This cannot be undone.
          </p>
          {!deleteOpen ? (
            <button type="button" className="btn btn-danger" onClick={() => setDeleteOpen(true)}>
              Delete account…
            </button>
          ) : (
            <div className="danger-confirm">
              {needsCurrent ? (
                <div className="field">
                  <label htmlFor="del-password">Enter your password to confirm</label>
                  <input
                    id="del-password"
                    type="password"
                    value={deletePw}
                    onChange={(e) => setDeletePw(e.target.value)}
                    autoComplete="current-password"
                    autoFocus
                  />
                </div>
              ) : (
                <p className="danger-text">
                  You're signed in with Google — confirming below deletes the account immediately.
                </p>
              )}
              {deleteError && <div className="form-error" role="alert">{deleteError}</div>}
              <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void deleteAccount()}
                  disabled={deleting || (needsCurrent && deletePw === '')}
                >
                  {deleting ? 'Deleting…' : 'Permanently delete my account'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDeleteOpen(false);
                    setDeletePw('');
                    setDeleteError('');
                  }}
                  disabled={deleting}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
