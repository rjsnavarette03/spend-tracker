import { useCallback, useEffect, useState } from 'react';
import type { Category } from '../shared/types';
import { api } from './api';
import {
  DashboardIcon,
  ListIcon,
  TagIcon,
  TargetIcon,
  WalletIcon,
} from './components/Icons';
import { currentMonth } from './format';
import { Budgets } from './pages/Budgets';
import { Categories } from './pages/Categories';
import { Dashboard } from './pages/Dashboard';
import { Transactions } from './pages/Transactions';

type PageId = 'dashboard' | 'transactions' | 'budgets' | 'categories';

const NAV: Array<{ id: PageId; label: string; icon: JSX.Element }> = [
  { id: 'dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
  { id: 'transactions', label: 'Transactions', icon: <ListIcon /> },
  { id: 'budgets', label: 'Budgets', icon: <TargetIcon /> },
  { id: 'categories', label: 'Categories', icon: <TagIcon /> },
];

export default function App() {
  const [page, setPage] = useState<PageId>('dashboard');
  const [month, setMonth] = useState(currentMonth());
  const [categories, setCategories] = useState<Category[]>([]);
  const [version, setVersion] = useState('');

  const refreshCategories = useCallback(async () => {
    try {
      setCategories(await api.categories.list());
    } catch {
      // main process not ready yet; pages will surface real errors
    }
  }, []);

  useEffect(() => {
    void refreshCategories();
    api.app.version().then(setVersion).catch(() => {});
  }, [refreshCategories]);

  const onDataChanged = useCallback(() => {
    void refreshCategories();
  }, [refreshCategories]);

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
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {version && <>v{version} · </>}data stored locally
        </div>
      </aside>
      <main className="main">
        {page === 'dashboard' && (
          <Dashboard
            month={month}
            setMonth={setMonth}
            categories={categories}
            onDataChanged={onDataChanged}
          />
        )}
        {page === 'transactions' && (
          <Transactions
            month={month}
            setMonth={setMonth}
            categories={categories}
            onDataChanged={onDataChanged}
          />
        )}
        {page === 'budgets' && <Budgets month={month} setMonth={setMonth} />}
        {page === 'categories' && (
          <Categories categories={categories} onDataChanged={onDataChanged} />
        )}
      </main>
    </div>
  );
}
