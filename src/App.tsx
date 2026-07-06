import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import type { Account, Category, User } from '../shared/types';
import { api } from './api';
import { AccountModal } from './components/AccountModal';
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
import { currentMonth } from './format';

// Data shared across the app pages, provided by the layout's <Outlet> and read
// by each page route via useAppContext(). Kept in the layout (which never
// unmounts while navigating between pages) so month/categories/accounts persist.
export interface AppContext {
  month: string;
  setMonth: (m: string) => void;
  categories: Category[];
  accounts: Account[];
  onDataChanged: () => void;
}

export function useAppContext(): AppContext {
  return useOutletContext<AppContext>();
}

const NAV: Array<{ to: string; label: string; icon: JSX.Element }> = [
  { to: '/', label: 'Dashboard', icon: <DashboardIcon /> },
  { to: '/transactions', label: 'Transactions', icon: <ListIcon /> },
  { to: '/accounts', label: 'Accounts', icon: <BankIcon /> },
  { to: '/budgets', label: 'Budgets', icon: <TargetIcon /> },
  { to: '/categories', label: 'Categories', icon: <TagIcon /> },
];

export default function AppLayout({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [month, setMonth] = useState(currentMonth());
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
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

  useEffect(() => {
    void refreshCategories();
    void refreshAccounts();
  }, [refreshCategories, refreshAccounts]);

  const onDataChanged = useCallback(() => {
    void refreshCategories();
    void refreshAccounts();
  }, [refreshCategories, refreshAccounts]);

  const ctx: AppContext = { month, setMonth, categories, accounts, onDataChanged };

  return (
    <div className="app">
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
            <button className="btn-icon" onClick={() => setShowAccount(true)} title="Account settings">
              <SettingsIcon />
            </button>
            <button className="btn-icon" onClick={onLogout} title="Sign out">
              <LogoutIcon />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Outlet context={ctx} />
      </main>

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
