import { useState } from 'react';
import { api } from '../api';
import { WalletIcon } from '../components/Icons';
import { ThemeToggle } from '../components/ThemeToggle';
import { cleanError } from '../format';

// The unsubscribe link in reminder emails (?unsubscribe=<token>). It asks
// before turning anything off — mail scanners open links, people click — and
// works signed in or out: the token alone is enough, and only turns reminder
// emails off. (A mail provider's own one-click button posts to the API
// directly and never shows this screen.)
export function Unsubscribe({
  token,
  onDone,
}: {
  token: string;
  onDone: (changed: boolean) => void | Promise<void>; // changed = reminder emails were turned off
}) {
  const valid = /^[a-f0-9]{64}$/.test(token);
  const [state, setState] = useState<'ask' | 'busy' | 'done' | 'failed'>(valid ? 'ask' : 'failed');
  const [error, setError] = useState(valid ? '' : 'This unsubscribe link is incomplete. You can turn reminder emails off in Settings.');

  const unsubscribe = async () => {
    setState('busy');
    try {
      await api.reminders.unsubscribe(token);
      setState('done');
    } catch (err) {
      setError(cleanError(err));
      setState('failed');
    }
  };

  const [title, sub] =
    state === 'done'
      ? ['Reminder emails are off', 'You can turn them back on anytime in Settings. Reminders in the app stay on.']
      : state === 'failed'
        ? ["Couldn't use this link", 'Your reminder emails are unchanged.']
        : ['Turn off reminder emails?', "You'll stop getting SpendTracker's daily reminder emails. Reminders in the app stay on."];

  return (
    <div className="login-wrap">
      <div className="login-card">
        <ThemeToggle className="btn-icon login-theme-toggle" />
        <div className="login-logo">
          <span className="logo-badge logo-badge-lg">
            <WalletIcon size={22} />
          </span>
          <div>
            <div className="login-title">{title}</div>
            <div className="login-sub">{sub}</div>
          </div>
        </div>
        <div className="form-grid">
          {state === 'failed' && error && <div className="form-error" role="alert">{error}</div>}
          {state === 'ask' || state === 'busy' ? (
            <>
              <button
                type="button"
                className="btn btn-primary btn-block"
                onClick={() => void unsubscribe()}
                disabled={state === 'busy'}
              >
                {state === 'busy' ? 'Turning off…' : 'Turn off reminder emails'}
              </button>
              <button type="button" className="btn btn-block" onClick={() => void onDone(false)} disabled={state === 'busy'}>
                Keep them
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary btn-block" onClick={() => void onDone(state === 'done')}>
              Continue to SpendTracker
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
