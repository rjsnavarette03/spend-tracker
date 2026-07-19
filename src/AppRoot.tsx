import { lazy, useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { User } from '../shared/types';
import { api, AUTH_EXPIRED_EVENT } from './api';
import AppLayout, { useAppContext } from './App';
// Marketing, legal, and auth screens stay eager so the public landing and the
// signed-out flows paint instantly with no chunk fetch or Suspense flash.
import { Login } from './auth/Login';
import { ResetPassword } from './auth/ResetPassword';
import { VerifyEmail } from './auth/VerifyEmail';
import { Landing } from './pages/Landing';
import { LegalPage } from './pages/Legal';

// The signed-in app pages are code-split: an anonymous visitor never downloads
// them, and each loads on first navigation (behind the layout's Suspense +
// ChunkBoundary). Pages use named exports, hence the .then() interop.
const AccountDetail = lazy(() => import('./pages/AccountDetail').then((m) => ({ default: m.AccountDetail })));
const Accounts = lazy(() => import('./pages/Accounts').then((m) => ({ default: m.Accounts })));
const Budgets = lazy(() => import('./pages/Budgets').then((m) => ({ default: m.Budgets })));
const Categories = lazy(() => import('./pages/Categories').then((m) => ({ default: m.Categories })));
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const Subscriptions = lazy(() => import('./pages/Subscriptions').then((m) => ({ default: m.Subscriptions })));
const Transactions = lazy(() => import('./pages/Transactions').then((m) => ({ default: m.Transactions })));

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

// The backup verification link (?verify=<token>) the server emails on register.
// Like the reset link, it short-circuits routing so it always works.
function readVerifyToken(): string | null {
  const t = new URLSearchParams(window.location.search).get('verify');
  return t && /^[a-f0-9]{64}$/.test(t) ? t : null;
}
function clearVerifyParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('verify');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

// Only allow an internal, single-slash path as a post-login redirect target.
// The landing ("/") is a marketing page, not a useful post-login destination,
// so it (and anything invalid) falls back to the dashboard.
function safeNext(raw: string | null): string {
  const p = raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard';
  return p === '/' ? '/dashboard' : p;
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
  return <Accounts accounts={c.accounts} loaded={c.accountsLoaded} onDataChanged={c.onDataChanged} />;
}
function BudgetsPage() {
  return <Budgets />;
}
function CategoriesPage() {
  const c = useAppContext();
  return (
    <Categories categories={c.categories} loaded={c.categoriesLoaded} onDataChanged={c.onDataChanged} />
  );
}
function SettingsPage() {
  const c = useAppContext();
  return <Settings user={c.user} refreshUser={c.refreshUser} />;
}

export function AppRoot() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [googleClientId, setGoogleClientId] = useState('');
  const [resetToken, setResetToken] = useState<string | null>(readResetToken);
  const [verifyToken, setVerifyToken] = useState<string | null>(readVerifyToken);
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
    // The reset and verify-link flows establish their own session (both call
    // session_regenerate_id server-side). Running the initial /auth/me
    // concurrently races that: its pre-regeneration response can resolve after
    // the token flow has signed the user in and clobber the state back to anon,
    // bouncing the user to /login. Skip it while a token is in play; clearing
    // the token re-runs this effect and loads the (now valid) session.
    if (resetToken || verifyToken) return;
    void check();
  }, [check, resetToken, verifyToken]);

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
    navigate('/', { replace: true }); // back to the public landing after sign-out
  };

  // Email just got verified (via code or backup link): adopt the now-verified
  // user and drop them into the app.
  const onVerified = (u: User) => {
    setUser(u);
    setPhase('authed');
    navigate('/dashboard', { replace: true });
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

  // Backup verification link (?verify=<token>): redeem it, then drop the
  // (now signed-in, verified) user into the app. Priority like the reset flow.
  if (verifyToken) {
    const finish = () => {
      clearVerifyParam();
      setVerifyToken(null);
    };
    return (
      <VerifyEmail
        mode="link"
        token={verifyToken}
        onDone={(u) => {
          finish();
          onVerified(u);
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

  // The root path is the public marketing landing for everyone (the app itself
  // lives at /dashboard). Rendered even while the session is loading so it
  // paints instantly; the CTA reflects auth state once known.
  if (location.pathname === '/') return <Landing authed={phase === 'authed'} />;

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

  // Signed in but email not yet verified: no app access until they confirm.
  // The verify screen replaces every app route (the URL is cosmetic here).
  if (phase === 'authed' && user && !user.emailVerified) {
    return <VerifyEmail mode="code" email={user.email} onDone={onVerified} onSignOut={onLogout} />;
  }

  if (phase === 'authed' && user) {
    return (
      <Routes>
        <Route element={<AppLayout user={user} onLogout={onLogout} />}>
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="transactions" element={<TransactionsPage />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="accounts/:id" element={<AccountDetail />} />
          <Route path="subscriptions" element={<Subscriptions />} />
          <Route path="budgets" element={<BudgetsPage />} />
          <Route path="categories" element={<CategoriesPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        {/* Signed in: auth screens or unknown paths fall back to the dashboard. */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
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
