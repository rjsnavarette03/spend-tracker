import { useCallback, useEffect, useState } from 'react';
import type { User } from '../shared/types';
import { api, AUTH_EXPIRED_EVENT } from './api';
import App from './App';
import { Login } from './auth/Login';
import { ResetPassword } from './auth/ResetPassword';

type Phase = 'loading' | 'anon' | 'authed' | 'offline';

// A reset link (?reset=<token>) takes priority over any existing session so a
// user can always complete a reset. Read it once at module load, before render.
function readResetToken(): string | null {
  const t = new URLSearchParams(window.location.search).get('reset');
  return t && /^[a-f0-9]{64}$/.test(t) ? t : null;
}

function clearResetParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('reset');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

export function AuthGate() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [googleClientId, setGoogleClientId] = useState('');
  const [resetToken, setResetToken] = useState<string | null>(readResetToken);

  const check = useCallback(async () => {
    try {
      const me = await api.auth.me();
      setGoogleClientId(me.googleClientId);
      if (me.user) {
        setUser(me.user);
        setPhase('authed');
      } else {
        setUser(null);
        setPhase('anon');
      }
    } catch {
      setPhase('offline');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setPhase('anon');
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const onAuthed = (u: User) => {
    setUser(u);
    setPhase('authed');
  };

  const onLogout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // even if the request fails, drop to the login screen
    }
    setUser(null);
    setPhase('anon');
  };

  // Reset flow short-circuits everything else until it's finished/cancelled.
  if (resetToken) {
    const finish = () => {
      clearResetParam();
      setResetToken(null);
    };
    return (
      <ResetPassword
        token={resetToken}
        onDone={(u) => {
          finish();
          onAuthed(u);
        }}
        onCancel={() => {
          finish();
          if (!user) setPhase('anon');
        }}
      />
    );
  }

  if (phase === 'loading') {
    return <div className="fullpage-center loading">Loading…</div>;
  }
  if (phase === 'offline') {
    return (
      <div className="fullpage-center">
        <div className="empty-state">
          Can't reach the server. Check your connection and{' '}
          <button className="btn" onClick={() => { setPhase('loading'); void check(); }}>
            try again
          </button>
        </div>
      </div>
    );
  }
  if (phase === 'anon' || !user) {
    return <Login googleClientId={googleClientId} onAuthed={onAuthed} />;
  }
  return <App user={user} onLogout={onLogout} />;
}
