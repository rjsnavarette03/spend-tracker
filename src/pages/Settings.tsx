import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { User } from '../../shared/types';
import { api } from '../api';
import { toast } from '../components/feedback';
import { CheckIcon, EyeIcon, EyeOffIcon, KeyIcon, TagIcon, TrashIcon } from '../components/Icons';
import { cleanError } from '../format';
import { REMIND_DAYS } from '../schedule';

// When the daily reminder email goes out, in the user's time zone (the
// server's ReminderEmail::SEND_HOUR).
const REMINDER_EMAIL_HOUR = 7;

/** This device's IANA time zone ('Asia/Manila'), or '' if the browser won't say. */
function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** 'America/Argentina/Buenos_Aires' → 'Buenos Aires'. */
function zoneCity(tz: string): string {
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

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
// own card with their own Save button (independent saves), reminder emails
// switch on/off on the spot, plus a visually
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

  // Reminder emails switch on and off right away (no Save). Turning them on
  // saves this device's time zone, so 7 AM is the user's 7 AM.
  const [remindersOn, setRemindersOn] = useState(user.reminderEmails);
  const [reminderTz, setReminderTz] = useState(user.reminderTimezone);
  const [savingReminders, setSavingReminders] = useState(false);
  const [remindersError, setRemindersError] = useState('');
  const [confirmationSent, setConfirmationSent] = useState(false);
  const deviceTz = deviceTimezone();
  useEffect(() => {
    setRemindersOn(user.reminderEmails);
    setReminderTz(user.reminderTimezone);
  }, [user.reminderEmails, user.reminderTimezone]);

  // The monthly recap switches right away too, and shares the time zone.
  const [recapOn, setRecapOn] = useState(user.recapEmails);
  const [savingRecap, setSavingRecap] = useState(false);
  const [recapError, setRecapError] = useState('');
  useEffect(() => setRecapOn(user.recapEmails), [user.recapEmails]);
  const today = new Date();
  const thisMonth = today.toLocaleDateString('en-US', { month: 'long' });
  const nextFirst = new Date(today.getFullYear(), today.getMonth() + 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
  });

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

  /** On, off, or (already on) move the 7 AM to this device's time zone. */
  const saveReminders = async (enabled: boolean) => {
    setRemindersError('');
    setSavingReminders(true);
    const wasOn = remindersOn;
    try {
      const r = await api.auth.setReminders(enabled, enabled ? deviceTz : null);
      setRemindersOn(r.reminderEmails);
      setReminderTz(r.reminderTimezone);
      // Turning on from off emails a confirmation (see ReminderEmail::turnedOn).
      setConfirmationSent(enabled && !wasOn);
      refreshUser();
      toast.success(!enabled ? 'Reminder emails off' : wasOn ? 'Reminder time zone updated' : 'Reminder emails on');
    } catch (err) {
      setRemindersError(cleanError(err));
    } finally {
      setSavingReminders(false);
    }
  };

  const saveRecap = async (enabled: boolean) => {
    setRecapError('');
    setSavingRecap(true);
    try {
      const r = await api.auth.setRecap(enabled, enabled ? deviceTz : null);
      setRecapOn(r.recapEmails);
      setReminderTz(r.reminderTimezone);
      refreshUser();
      toast.success(enabled ? 'Monthly recap on' : 'Monthly recap off');
    } catch (err) {
      setRecapError(cleanError(err));
    } finally {
      setSavingRecap(false);
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
              <CheckIcon /> {savingCurrency ? 'Saving…' : 'Save currency'}
            </button>
          </div>
        </form>

        <div className="panel form-grid">
          <div className="panel-title" style={{ marginBottom: 0 }}>
            Email reminders
          </div>
          <div className="field-hint">
            An email around {REMINDER_EMAIL_HOUR}:00 AM on days something needs your attention: bills and
            payments due today or in the next {REMIND_DAYS} days, anything overdue, and paydays whose salary
            isn't logged yet. The same list as the bell, at most one email a day.
          </div>
          <div className="field">
            <label id="set-reminders">Reminder emails</label>
            <div
              className="segmented"
              role="group"
              aria-labelledby="set-reminders"
              style={{ alignSelf: 'flex-start' }}
            >
              <button
                type="button"
                className={!remindersOn ? 'active-account' : ''}
                aria-pressed={!remindersOn}
                disabled={savingReminders}
                onClick={() => remindersOn && void saveReminders(false)}
              >
                Off
              </button>
              <button
                type="button"
                className={remindersOn ? 'active-account' : ''}
                aria-pressed={remindersOn}
                disabled={savingReminders}
                onClick={() => !remindersOn && void saveReminders(true)}
              >
                On
              </button>
            </div>
            {remindersOn && reminderTz && (
              <div className="field-hint">
                Sent to {user.email} around {REMINDER_EMAIL_HOUR}:00 AM {zoneCity(reminderTz)} time.
                {deviceTz !== '' && deviceTz !== reminderTz && (
                  <>
                    {' '}This device is on {zoneCity(deviceTz)} time —{' '}
                    <button
                      type="button"
                      className="link-btn"
                      disabled={savingReminders}
                      onClick={() => void saveReminders(true)}
                    >
                      use {zoneCity(deviceTz)} time
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {confirmationSent && remindersOn && (
            <div className="notice notice-block">
              We sent a confirmation to {user.email}. If it isn't in your inbox, check spam and mark it as not
              spam, so the reminders get through.
            </div>
          )}
          {remindersError && <div className="form-error" role="alert">{remindersError}</div>}
        </div>

        <div className="panel form-grid">
          <div className="panel-title" style={{ marginBottom: 0 }}>
            Monthly recap
          </div>
          <div className="field-hint">
            An email on the 1st of each month about the month before: income and spending compared with the month
            before that, where the money went, monthly budgets that went over, and your net worth and debt.
          </div>
          <div className="field">
            <label id="set-recap">Monthly recap email</label>
            <div className="segmented" role="group" aria-labelledby="set-recap" style={{ alignSelf: 'flex-start' }}>
              <button
                type="button"
                className={!recapOn ? 'active-account' : ''}
                aria-pressed={!recapOn}
                disabled={savingRecap}
                onClick={() => recapOn && void saveRecap(false)}
              >
                Off
              </button>
              <button
                type="button"
                className={recapOn ? 'active-account' : ''}
                aria-pressed={recapOn}
                disabled={savingRecap}
                onClick={() => !recapOn && void saveRecap(true)}
              >
                On
              </button>
            </div>
            {recapOn && (
              <div className="field-hint">
                Sent to {user.email} around {REMINDER_EMAIL_HOUR}:00 AM
                {reminderTz ? ` ${zoneCity(reminderTz)} time` : ''} on the 1st. The next one, about {thisMonth}, comes
                on {nextFirst}. If it doesn't arrive, check spam.
              </div>
            )}
          </div>
          {recapError && <div className="form-error" role="alert">{recapError}</div>}
        </div>

        {/* Categories has no slot in the mobile tab bar, so it's reached from here. */}
        <div className="panel form-grid">
          <div className="panel-title" style={{ marginBottom: 0 }}>
            Categories
          </div>
          <div className="field-hint">
            The income and expense categories used by transactions, budgets and bills.
          </div>
          <div className="form-actions">
            <Link to="/categories" className="btn">
              <TagIcon /> Manage categories
            </Link>
          </div>
        </div>

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
              <KeyIcon /> {savingPassword ? 'Saving…' : needsCurrent ? 'Change password' : 'Set password'}
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
              <TrashIcon /> Delete account…
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
                  <TrashIcon /> {deleting ? 'Deleting…' : 'Permanently delete my account'}
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
