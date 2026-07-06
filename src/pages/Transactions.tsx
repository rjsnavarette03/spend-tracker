import { useCallback, useEffect, useState } from 'react';
import type { Category, Transaction, TxFilter, TxType } from '../../shared/types';
import { api } from '../api';
import { DownloadIcon, PencilIcon, PlusIcon, TrashIcon } from '../components/Icons';
import { MonthPicker } from '../components/MonthPicker';
import { TransactionModal } from '../components/TransactionModal';
import { cleanError, dateLabel, fmtMoney, fmtSigned, monthLabel } from '../format';

export function Transactions({
  month,
  setMonth,
  categories,
  onDataChanged,
}: {
  month: string;
  setMonth: (m: string) => void;
  categories: Category[];
  onDataChanged: () => void;
}) {
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TxType | 'all'>('all');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<{ open: boolean; editing: Transaction | null }>({
    open: false,
    editing: null,
  });
  const [notice, setNotice] = useState('');

  const filter: TxFilter = {
    month,
    type: typeFilter,
    categoryId: catFilter === 'all' ? 'all' : Number(catFilter),
    search,
  };

  const load = useCallback(async () => {
    try {
      setTxs(
        await api.transactions.list({
          month,
          type: typeFilter,
          categoryId: catFilter === 'all' ? 'all' : Number(catFilter),
          search,
        })
      );
      setLoaded(true);
    } catch (err) {
      alert(cleanError(err));
    }
  }, [month, typeFilter, catFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterMutation = () => {
    void load();
    onDataChanged();
  };

  const remove = async (t: Transaction) => {
    const label = `${fmtMoney(t.amountCents)} ${t.type} on ${dateLabel(t.date)}`;
    if (!window.confirm(`Delete this transaction?\n\n${label}`)) return;
    try {
      await api.transactions.remove(t.id);
      afterMutation();
    } catch (err) {
      alert(cleanError(err));
    }
  };

  const exportCsv = async () => {
    try {
      const result = await api.transactions.exportCsv(filter);
      if (result.saved && result.path) {
        setNotice(`Exported to ${result.path}`);
        setTimeout(() => setNotice(''), 5000);
      }
    } catch (err) {
      alert(cleanError(err));
    }
  };

  const incomeTotal = txs.filter((t) => t.type === 'income').reduce((s, t) => s + t.amountCents, 0);
  const expenseTotal = txs
    .filter((t) => t.type === 'expense')
    .reduce((s, t) => s + t.amountCents, 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Transactions</h1>
          <div className="page-sub">
            {txs.length} {txs.length === 1 ? 'entry' : 'entries'} in {monthLabel(month)}
          </div>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={exportCsv} disabled={txs.length === 0}>
            <DownloadIcon /> Export CSV
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setModal({ open: true, editing: null })}
          >
            <PlusIcon /> Add transaction
          </button>
        </div>
      </div>

      <div className="toolbar">
        <MonthPicker value={month} onChange={setMonth} />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TxType | 'all')}>
          <option value="all">All types</option>
          <option value="income">Income</option>
          <option value="expense">Expenses</option>
        </select>
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Search note or category…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="spacer" />
        {notice && <span className="notice">{notice}</span>}
      </div>

      {loaded && txs.length === 0 ? (
        <div className="empty-state">
          No transactions match. Try a different month or filter, or add one.
          <br />
          <button
            className="btn btn-primary"
            onClick={() => setModal({ open: true, editing: null })}
          >
            <PlusIcon /> Add transaction
          </button>
        </div>
      ) : (
        <div className="panel" style={{ padding: '6px 8px' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Category</th>
                <th>Note</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {txs.map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dateLabel(t.date)}</td>
                  <td>
                    <span className="cat-chip">
                      <span
                        className="color-dot"
                        style={{ background: t.categoryColor ?? '#64748b' }}
                      />
                      <span>{t.categoryName ?? 'Uncategorized'}</span>
                    </span>
                  </td>
                  <td className="note-cell">{t.note}</td>
                  <td className={`num amount-${t.type}`}>{fmtSigned(t.amountCents, t.type)}</td>
                  <td className="actions">
                    <button
                      className="btn-icon"
                      title="Edit"
                      onClick={() => setModal({ open: true, editing: t })}
                    >
                      <PencilIcon />
                    </button>
                    <button className="btn-icon danger" title="Delete" onClick={() => remove(t)}>
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="totals-bar">
            <span>
              Income <b className="amount-income">{fmtMoney(incomeTotal)}</b>
            </span>
            <span>
              Expenses <b className="amount-expense">{fmtMoney(expenseTotal)}</b>
            </span>
            <span>
              Net <b>{fmtMoney(incomeTotal - expenseTotal)}</b>
            </span>
          </div>
        </div>
      )}

      {modal.open && (
        <TransactionModal
          initial={modal.editing}
          categories={categories}
          defaultMonth={month}
          onClose={() => setModal({ open: false, editing: null })}
          onSaved={afterMutation}
        />
      )}
    </div>
  );
}
