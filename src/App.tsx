import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import type { Account, Category, User } from '../shared/types';
import { api } from './api';
import { AccountModal } from './components/AccountModal';
import { ThemeToggle } from './components/ThemeToggle';
import {
  BankIcon,
  DashboardIcon,
  ListIcon,
  LogoutIcon,
  SettingsIcon,
  TagIcon,
  TargetIcon,
  WalletIcon,
} from './components/Icons';
import { currentPeriod } from './format';
import type { Period } from './format';

// Data shared across the app pages, provided by the layout's <Outlet> and read
// by each page route via useAppContext(). Kept in the layout (which never
// unmounts while navigating between pages) so month/categories/accounts persist.
export interface AppContext {
  period: Period;
  setPeriod: (p: Period) => void;
  categories: Category[];
  accounts: Account[];
  // Years that have transactions — drives the year picker (see PeriodPicker).
  availableYears: number[];
  onDataChanged: () => void;
}

export function useAppContext(): AppContext {
  return useOutletContext<AppContext>();
}

const NAV: Array<{ to: string; label: string; icon: JSX.Element }> = [
  { to: '/dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
  { to: '/transactions', label: 'Transactions', icon: <ListIcon /> },
  { to: '/accounts', label: 'Accounts', icon: <BankIcon /> },
  { to: '/budgets', label: 'Budgets', icon: <TargetIcon /> },
  { to: '/categories', label: 'Categories', icon: <TagIcon /> },
];

export default function AppLayout({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [period, setPeriod] = useState<Period>(() => currentPeriod('month'));
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  // Local copy so hasPassword/hasGoogle can refresh after account changes.
  const [account, setAccount] = useState<User>(user);
  const [showAccount, setShowAccount] = useState(false);

  const refreshCategories = useCallback(async () => {
    try {
      setCategories(await api.categories.list());
    } catch {
      // pages surface real errors; a failed refresh here is non-fatal
    }
  }, []);

  // Balances change with any transaction/transfer mutation, so this refreshes
  // alongside categories via onDataChanged.
  const refreshAccounts = useCallback(async () => {
    try {
      setAccounts(await api.accounts.list());
    } catch {
      // non-fatal
    }
  }, []);

  const refreshAccount = useCallback(async () => {
    try {
      const me = await api.auth.me();
      if (me.user) setAccount(me.user);
    } catch {
      // non-fatal
    }
  }, []);

  // Years with transactions change only when a tx lands in a new year, so this
  // rides along with the other refreshes rather than getting its own trigger.
  const refreshYears = useCallback(async () => {
    try {
      setAvailableYears(await api.reports.years());
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    void refreshCategories();
    void refreshAccounts();
    void refreshYears();
  }, [refreshCategories, refreshAccounts, refreshYears]);

  const onDataChanged = useCallback(() => {
    void refreshCategories();
    void refreshAccounts();
    void refreshYears();
  }, [refreshCategories, refreshAccounts, refreshYears]);

  const ctx: AppContext = { period, setPeriod, categories, accounts, availableYears, onDataChanged };

  return (
    <div className="app">
      {/* Mobile-only top bar: brand + account actions (hidden on desktop). The
          nav itself lives in the bottom .tabbar on mobile, like a native app. */}
      <header className="mobile-topbar">
        <div className="logo">
          <span className="logo-badge">
            <WalletIcon size={17} />
          </span>
          SpendTracker
        </div>
        <div className="mobile-topbar-actions">
          <ThemeToggle />
          <button
            className="btn-icon"
            onClick={() => setShowAccount(true)}
            title="Account settings"
            aria-label="Account settings"
          >
            <SettingsIcon />
          </button>
          <button
            className="btn-icon logout-btn"
            onClick={onLogout}
            title="Sign out"
            aria-label="Sign out"
          >
            <LogoutIcon />
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="logo">
          <span className="logo-badge">
            <WalletIcon size={17} />
          </span>
          SpendTracker
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              {item.icon}
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-line" title={account.email}>
            <span className="user-email">{account.name || account.email}</span>
            <div className="user-actions">
              <ThemeToggle />
              <button className="btn-icon" onClick={() => setShowAccount(true)} title="Account settings">
                <SettingsIcon />
              </button>
              <button className="btn-icon logout-btn" onClick={onLogout} title="Sign out">
                <LogoutIcon />
              </button>
            </div>
          </div>
          <div className="sidebar-legal">
            <a href="/privacy" target="_blank" rel="noopener noreferrer">
              Privacy
            </a>
            <span aria-hidden="true">·</span>
            <a href="/terms" target="_blank" rel="noopener noreferrer">
              Terms
            </a>
          </div>
        </div>
      </aside>
      <main className="main">
        <Outlet context={ctx} />
      </main>

      {/* Mobile-only bottom tab bar (hidden on desktop). */}
      <nav className="tabbar" aria-label="Primary">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}
          >
            {item.icon}
            <span className="tab-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {showAccount && (
        <AccountModal
          user={account}
          onClose={() => setShowAccount(false)}
          onChanged={refreshAccount}
        />
      )}
    </div>
  );
}
