import { useCallback, useEffect, useState } from 'react';
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
import { Accounts } from './pages/Accounts';
import { Budgets } from './pages/Budgets';
import { Categories } from './pages/Categories';
import { Dashboard } from './pages/Dashboard';
import { Transactions } from './pages/Transactions';

type PageId = 'dashboard' | 'transactions' | 'accounts' | 'budgets' | 'categories';

const NAV: Array<{ id: PageId; label: string; icon: JSX.Element }> = [
  { id: 'dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
  { id: 'transactions', label: 'Transactions', icon: <ListIcon /> },
  { id: 'accounts', label: 'Accounts', icon: <BankIcon /> },
  { id: 'budgets', label: 'Budgets', icon: <TargetIcon /> },
  { id: 'categories', label: 'Categories', icon: <TagIcon /> },
];

export default function App({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [page, setPage] = useState<PageId>('dashboard');
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
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => setPage(item.id)}
            >
              {item.icon}
              <span className="nav-label">{item.label}</span>
            </button>
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
        {page === 'dashboard' && (
          <Dashboard
            month={month}
            setMonth={setMonth}
            categories={categories}
            accounts={accounts}
            onDataChanged={onDataChanged}
          />
        )}
        {page === 'transactions' && (
          <Transactions
            month={month}
            setMonth={setMonth}
            categories={categories}
            accounts={accounts}
            onDataChanged={onDataChanged}
          />
        )}
        {page === 'accounts' && <Accounts accounts={accounts} onDataChanged={onDataChanged} />}
        {page === 'budgets' && <Budgets month={month} setMonth={setMonth} />}
        {page === 'categories' && (
          <Categories categories={categories} onDataChanged={onDataChanged} />
        )}
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
