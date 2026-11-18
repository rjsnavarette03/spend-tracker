import { useState } from 'react';
import { api } from '../api';
import { WalletIcon } from '../components/Icons';
import { ThemeToggle } from '../components/ThemeToggle';
import { cleanError } from '../format';

// The words for each email that has an unsubscribe link.
const COPY = {
  reminders: {
    name: 'reminder emails',
    ask: ['Turn off reminder emails?', "You'll stop getting SpendTracker's daily reminder emails. Reminders in the app stay on."],
    done: ['Reminder emails are off', 'You can turn them back on anytime in Settings. Reminders in the app stay on.'],
    unchanged: 'Your reminder emails are unchanged.',
    button: 'Turn off reminder emails',
    keep: 'Keep them',
  },
  recap: {
    name: 'the monthly recap',
    ask: ['Turn off the monthly recap?', "You'll stop getting SpendTracker's monthly recap email. Reminder emails stay as they are."],
    done: ['The monthly recap is off', 'You can turn it back on anytime in Settings.'],
    unchanged: 'Your monthly recap is unchanged.',
    button: 'Turn off the monthly recap',
    keep: 'Keep it',
  },
} as const;

// The unsubscribe link in reminder and recap emails (?unsubscribe=<token>,
// plus &list=recap for the recap). It asks before turning anything off —
// mail scanners open links, people click — and works signed in or out: the
// token alone is enough, and only turns that one email off. (A mail
// provider's own one-click button posts to the API directly and never shows
// this screen.)
export function Unsubscribe({
  token,
  list = 'reminders',
  onDone,
}: {
  token: string;
  list?: 'reminders' | 'recap';
  onDone: (changed: boolean) => void | Promise<void>; // changed = the email was turned off
}) {
  const copy = COPY[list];
  const valid = /^[a-f0-9]{64}$/.test(token);
  const [state, setState] = useState<'ask' | 'busy' | 'done' | 'failed'>(valid ? 'ask' : 'failed');
  const [error, setError] = useState(valid ? '' : `This unsubscribe link is incomplete. You can turn ${copy.name} off in Settings.`);

  const unsubscribe = async () => {
    setState('busy');
    try {
      await api.reminders.unsubscribe(token, list);
      setState('done');
    } catch (err) {
      setError(cleanError(err));
      setState('failed');
    }
  };

  const [title, sub] =
    state === 'done' ? copy.done : state === 'failed' ? ["Couldn't use this link", copy.unchanged] : copy.ask;

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
                {state === 'busy' ? 'Turning off…' : copy.button}
              </button>
              <button type="button" className="btn btn-block" onClick={() => void onDone(false)} disabled={state === 'busy'}>
                {copy.keep}
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
