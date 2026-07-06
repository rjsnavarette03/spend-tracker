import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { User } from '../shared/types';
import { api, AUTH_EXPIRED_EVENT } from './api';
import AppLayout, { useAppContext } from './App';
import { Login } from './auth/Login';
import { ResetPassword } from './auth/ResetPassword';
import { AccountDetail } from './pages/AccountDetail';
import { Accounts } from './pages/Accounts';
import { Budgets } from './pages/Budgets';
import { Categories } from './pages/Categories';
import { Dashboard } from './pages/Dashboard';
import { LegalPage } from './pages/Legal';
import { Transactions } from './pages/Transactions';

type Phase = 'loading' | 'anon' | 'authed' | 'offline';

// A reset link (?reset=<token>) is what the server emails (see auth.php); it
// takes priority over routing so a user can always complete a reset.
function readResetToken(): string | null {
  const t = new URLSearchParams(window.location.search).get('reset');
  return t && /^[a-f0-9]{64}$/.test(t) ? t : null;
}
function clearResetParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('reset');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

// Only allow an internal, single-slash path as a post-login redirect target.
function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

// Page route elements: pull the shared data from the layout's Outlet context
// and render the corresponding page.
function DashboardPage() {
  const c = useAppContext();
  return (
    <Dashboard
      period={c.period}
      setPeriod={c.setPeriod}
      categories={c.categories}
      accounts={c.accounts}
      availableYears={c.availableYears}
      onDataChanged={c.onDataChanged}
    />
  );
}
function TransactionsPage() {
  const c = useAppContext();
  return (
    <Transactions
      period={c.period}
      setPeriod={c.setPeriod}
      categories={c.categories}
      accounts={c.accounts}
      availableYears={c.availableYears}
      onDataChanged={c.onDataChanged}
    />
  );
}
function AccountsPage() {
  const c = useAppContext();
  return <Accounts accounts={c.accounts} onDataChanged={c.onDataChanged} />;
}
function BudgetsPage() {
  return <Budgets />;
}
function CategoriesPage() {
  const c = useAppContext();
  return <Categories categories={c.categories} onDataChanged={c.onDataChanged} />;
}

export function AppRoot() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [googleClientId, setGoogleClientId] = useState('');
  const [resetToken, setResetToken] = useState<string | null>(readResetToken);
  const navigate = useNavigate();
  const location = useLocation();

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
      navigate('/login', { replace: true });
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [navigate]);

  const onAuthed = (u: User) => {
    setUser(u);
    setPhase('authed');
    const next = safeNext(new URLSearchParams(window.location.search).get('next'));
    navigate(next, { replace: true });
  };

  const onLogout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // even if the request fails, drop to the login screen
    }
    setUser(null);
    setPhase('anon');
    navigate('/login', { replace: true });
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
          navigate('/login', { replace: true });
        }}
      />
    );
  }

  // Privacy Policy & Terms are public: reachable whether signed in, signed out,
  // or still loading the session — so links work from anywhere.
  if (location.pathname === '/privacy') return <LegalPage doc="privacy" />;
  if (location.pathname === '/terms') return <LegalPage doc="terms" />;

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

  if (phase === 'authed' && user) {
    return (
      <Routes>
        <Route element={<AppLayout user={user} onLogout={onLogout} />}>
          <Route index element={<DashboardPage />} />
          <Route path="transactions" element={<TransactionsPage />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="accounts/:id" element={<AccountDetail />} />
          <Route path="budgets" element={<BudgetsPage />} />
          <Route path="categories" element={<CategoriesPage />} />
        </Route>
        {/* Signed in: auth screens or unknown paths fall back to the dashboard. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  // Signed out.
  const loginNext = encodeURIComponent(location.pathname + location.search);
  return (
    <Routes>
      <Route path="/login" element={<Login mode="signin" googleClientId={googleClientId} onAuthed={onAuthed} />} />
      <Route path="/register" element={<Login mode="register" googleClientId={googleClientId} onAuthed={onAuthed} />} />
      <Route path="/forgot-password" element={<Login mode="forgot" googleClientId={googleClientId} onAuthed={onAuthed} />} />
      {/* Any other (protected) path while signed out -> login, preserving destination. */}
      <Route path="*" element={<Navigate to={`/login?next=${loginNext}`} replace />} />
    </Routes>
  );
}
