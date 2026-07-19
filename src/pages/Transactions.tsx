import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, Category, Transaction, TxType } from '../../shared/types';
import { api } from '../api';
import { confirm, toast } from '../components/feedback';
import { DownloadIcon, PencilIcon, PlusIcon, TrashIcon } from '../components/Icons';
import { Pager } from '../components/Pager';
import { PeriodPicker } from '../components/PeriodPicker';
import { TransactionModal } from '../components/TransactionModal';
import {
  cleanError,
  dateLabel,
  downloadFile,
  fmtMoney,
  fmtSigned,
  periodLabel,
  transactionsToCsv,
} from '../format';
import type { Period } from '../format';
import { usePagedTable } from '../usePagedTable';
import type { SortOption } from '../usePagedTable';

// Search matches the note, category and account name; sort choices bake in
// their direction (matching the accounts-page sort dropdown pattern).
const TX_SEARCH = (t: Transaction) => `${t.note} ${t.categoryName ?? ''} ${t.accountName ?? ''}`;

const TX_SORTS: SortOption<Transaction>[] = [
  {
    value: 'date-desc',
    label: 'Date (newest)',
    compare: (a, b) => b.date.localeCompare(a.date) || b.id - a.id,
  },
  {
    value: 'date-asc',
    label: 'Date (oldest)',
    compare: (a, b) => a.date.localeCompare(b.date) || a.id - b.id,
  },
  {
    value: 'amount-desc',
    label: 'Amount (high–low)',
    compare: (a, b) => b.amountCents - a.amountCents,
  },
  {
    value: 'amount-asc',
    label: 'Amount (low–high)',
    compare: (a, b) => a.amountCents - b.amountCents,
  },
  {
    value: 'cat-asc',
    label: 'Category (A–Z)',
    compare: (a, b) =>
      (a.categoryName ?? 'Uncategorized').localeCompare(b.categoryName ?? 'Uncategorized', undefined, {
        sensitivity: 'base',
      }),
  },
];

export function Transactions({
  period,
  setPeriod,
  categories,
  accounts,
  availableYears,
  onDataChanged,
}: {
  period: Period;
  setPeriod: (p: Period) => void;
  categories: Category[];
  accounts: Account[];
  availableYears: number[];
  onDataChanged: () => void;
}) {
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TxType | 'all'>('all');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [modal, setModal] = useState<{ open: boolean; editing: Transaction | null }>({
    open: false,
    editing: null,
  });
  const [notice, setNotice] = useState('');

  // Type/category/period stay server-side filters; search + sort + pagination
  // run client-side over the loaded rows so they reflect instantly.
  const paged = usePagedTable(txs, TX_SEARCH, TX_SORTS, { initialSort: 'date-desc' });

  // Monotonic request id: a slow earlier response can resolve after a newer
  // one, so ignore any result that isn't from the latest request in flight.
  const reqSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      const rows = await api.transactions.list({
        from: period.start,
        to: period.end,
        type: typeFilter,
        categoryId: catFilter === 'all' ? 'all' : Number(catFilter),
      });
      if (seq !== reqSeq.current) return; // superseded — drop stale result
      setTxs(rows);
      setLoaded(true);
    } catch (err) {
      if (seq === reqSeq.current) toast.error(cleanError(err));
    }
  }, [period, typeFilter, catFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterMutation = () => {
    void load();
    onDataChanged();
  };

  const remove = async (t: Transaction) => {
    const label = `${fmtMoney(t.amountCents)} ${t.type} on ${dateLabel(t.date)}`;
    const ok = await confirm({
      title: 'Delete transaction',
      message: label,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.transactions.remove(t.id);
      afterMutation();
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  // Export / totals cover the full matched set (all pages, after search), not
  // just the current page.
  const matched = paged.matched;
  const exportCsv = () => {
    downloadFile(
      `transactions-${period.start}_${period.end}.csv`,
      transactionsToCsv(matched),
      'text/csv;charset=utf-8'
    );
    setNotice(`Exported ${matched.length} ${matched.length === 1 ? 'entry' : 'entries'}`);
    setTimeout(() => setNotice(''), 4000);
  };

  const incomeTotal = matched
    .filter((t) => t.type === 'income')
    .reduce((s, t) => s + t.amountCents, 0);
  const expenseTotal = matched
    .filter((t) => t.type === 'expense')
    .reduce((s, t) => s + t.amountCents, 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Transactions</h1>
          <div className="page-sub">
            {paged.matchedCount} {paged.matchedCount === 1 ? 'entry' : 'entries'}
            {paged.query ? ' matched' : ''} in {periodLabel(period)}
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
        <PeriodPicker value={period} onChange={setPeriod} availableYears={availableYears} />
        <select
          aria-label="Filter by type"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as TxType | 'all')}
        >
          <option value="all">All types</option>
          <option value="income">Income</option>
          <option value="expense">Expenses</option>
        </select>
        <select
          aria-label="Filter by category"
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
        >
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort transactions"
          value={paged.sort}
          onChange={(e) => paged.setSort(e.target.value)}
        >
          {TX_SORTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Search note, category or account…"
          value={paged.query}
          onChange={(e) => paged.setQuery(e.target.value)}
        />
        <div className="spacer" />
        {notice && <span className="notice">{notice}</span>}
      </div>

      {loaded && paged.matchedCount === 0 ? (
        <div className="empty-state">
          {paged.totalCount === 0 ? (
            <>
              No transactions in {periodLabel(period)}. Try a different period or filter, or add
              one.
              <br />
              <button
                className="btn btn-primary"
                onClick={() => setModal({ open: true, editing: null })}
              >
                <PlusIcon /> Add transaction
              </button>
            </>
          ) : (
            'No transactions match your search.'
          )}
        </div>
      ) : (
        <div className="panel table-panel">
          {/* tx-cards: ≤860px CSS restacks each row into a native-app list card */}
          <table className="table tx-cards">
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
              {paged.visible.map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dateLabel(t.date)}</td>
                  <td>
                    <span className="chip-stack">
                      <span className="cat-chip">
                        <span
                          className="color-dot"
                          style={{ background: t.categoryColor ?? '#64748b' }}
                        />
                        <span>{t.categoryName ?? 'Uncategorized'}</span>
                      </span>
                      {t.accountName && (
                        <span className="cat-chip account-chip" title={`Account: ${t.accountName}`}>
                          <span
                            className="color-dot"
                            style={{ background: t.accountColor ?? '#64748b' }}
                          />
                          <span>{t.accountName}</span>
                        </span>
                      )}
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
          <Pager
            page={paged.page}
            pageCount={paged.pageCount}
            pageSize={paged.pageSize}
            setPage={paged.setPage}
            setPageSize={paged.setPageSize}
            rangeStart={paged.rangeStart}
            rangeEnd={paged.rangeEnd}
            total={paged.matchedCount}
            unit="entries"
          />
        </div>
      )}

      {modal.open && (
        <TransactionModal
          initial={modal.editing}
          categories={categories}
          accounts={accounts}
          defaultMonth={period.start.slice(0, 7)}
          onClose={() => setModal({ open: false, editing: null })}
          onSaved={afterMutation}
        />
      )}
    </div>
  );
}
