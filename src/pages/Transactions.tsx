import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, Category, Transaction, Transfer, TxType } from '../../shared/types';
import { api } from '../api';
import { confirm, toast } from '../components/feedback';
import { DownloadIcon, PencilIcon, PlusIcon, TransferIcon, TrashIcon } from '../components/Icons';
import { Pager } from '../components/Pager';
import { PeriodPicker } from '../components/PeriodPicker';
import { TransactionModal } from '../components/TransactionModal';
import { TransferModal } from '../components/TransferModal';
import { cleanError, dateLabel, downloadFile, fmtMoney, fmtSigned, periodLabel, timeLabel } from '../format';
import type { Period } from '../format';
import { usePagedTable } from '../usePagedTable';
import type { SortOption } from '../usePagedTable';

// The ledger interleaves ordinary transactions with transfers (loan/credit
// payments, borrows, account-to-account moves). Transfers appear as rows but
// are EXCLUDED from the Income/Expenses/Net totals: they move money between
// the user's own accounts, so counting them would double-count spending.
type Row = { kind: 'tx'; t: Transaction } | { kind: 'transfer'; tr: Transfer };

const rowId = (r: Row) => (r.kind === 'tx' ? r.t.id : r.tr.id);
const rowDate = (r: Row) => (r.kind === 'tx' ? r.t.date : r.tr.date);
// 'HH:MM' sorts lexicographically; '' (no time) sorts before any time, so
// untimed rows land last on newest-first — matching the server.
const rowTime = (r: Row) => (r.kind === 'tx' ? r.t.time ?? '' : r.tr.time ?? '');
const rowAmount = (r: Row) => (r.kind === 'tx' ? r.t.amountCents : r.tr.amountCents);
const rowCatLabel = (r: Row) =>
  r.kind === 'tx' ? r.t.categoryName ?? 'Uncategorized' : 'Transfer';

// Search matches note, category, account names — and for transfers the words
// "transfer"/"payment" so typing either surfaces them.
const ROW_SEARCH = (r: Row) =>
  r.kind === 'tx'
    ? `${r.t.note} ${r.t.categoryName ?? ''} ${r.t.accountName ?? ''}`
    : `${r.tr.note} ${r.tr.fromName ?? ''} ${r.tr.toName ?? ''} transfer payment`;

const ROW_SORTS: SortOption<Row>[] = [
  {
    value: 'date-desc',
    label: 'Date (newest)',
    compare: (a, b) =>
      rowDate(b).localeCompare(rowDate(a)) ||
      rowTime(b).localeCompare(rowTime(a)) ||
      rowId(b) - rowId(a),
  },
  {
    value: 'date-asc',
    label: 'Date (oldest)',
    compare: (a, b) =>
      rowDate(a).localeCompare(rowDate(b)) ||
      rowTime(a).localeCompare(rowTime(b)) ||
      rowId(a) - rowId(b),
  },
  {
    value: 'amount-desc',
    label: 'Amount (high–low)',
    compare: (a, b) => rowAmount(b) - rowAmount(a),
  },
  {
    value: 'amount-asc',
    label: 'Amount (low–high)',
    compare: (a, b) => rowAmount(a) - rowAmount(b),
  },
  {
    value: 'cat-asc',
    label: 'Category (A–Z)',
    compare: (a, b) => rowCatLabel(a).localeCompare(rowCatLabel(b), undefined, { sensitivity: 'base' }),
  },
];

function rowsToCsv(rows: Row[]): string {
  const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['Date,Time,Type,Category,Account,Note,Amount'];
  for (const r of rows) {
    if (r.kind === 'tx') {
      const t = r.t;
      lines.push(
        [
          t.date,
          t.time ?? '',
          t.type,
          esc(t.categoryName ?? 'Uncategorized'),
          esc(t.accountName ?? ''),
          esc(t.note),
          (t.amountCents / 100).toFixed(2),
        ].join(',')
      );
    } else {
      const tr = r.tr;
      lines.push(
        [
          tr.date,
          tr.time ?? '',
          'transfer',
          esc('Transfer'),
          esc(`${tr.fromName ?? 'Deleted account'} → ${tr.toName ?? 'Deleted account'}`),
          esc(tr.feeCents > 0 ? `${tr.note} (fee ${(tr.feeCents / 100).toFixed(2)})` : tr.note),
          (tr.amountCents / 100).toFixed(2),
        ].join(',')
      );
    }
  }
  return '﻿' + lines.join('\r\n');
}

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
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TxType | 'all' | 'transfer'>('all');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [modal, setModal] = useState<{ open: boolean; editing: Transaction | null }>({
    open: false,
    editing: null,
  });
  const [transferModal, setTransferModal] = useState<{ open: boolean; editing: Transfer | null }>({
    open: false,
    editing: null,
  });
  const [notice, setNotice] = useState('');

  // Transfers join the list only on "All types" / "Transfers & payments", and
  // never under a category filter (transfers have no category).
  const includeTransfers = (typeFilter === 'all' || typeFilter === 'transfer') && catFilter === 'all';

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (typeFilter !== 'transfer') for (const t of txs) out.push({ kind: 'tx', t });
    if (includeTransfers) for (const tr of transfers) out.push({ kind: 'transfer', tr });
    return out;
  }, [txs, transfers, typeFilter, includeTransfers]);

  // Type/category/period stay server-side filters; search + sort + pagination
  // run client-side over the loaded rows so they reflect instantly.
  const paged = usePagedTable(rows, ROW_SEARCH, ROW_SORTS, { initialSort: 'date-desc' });

  // Monotonic request id: a slow earlier response can resolve after a newer
  // one, so ignore any result that isn't from the latest request in flight.
  const reqSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      const [t, allTransfers] = await Promise.all([
        typeFilter === 'transfer'
          ? Promise.resolve([] as Transaction[])
          : api.transactions.list({
              from: period.start,
              to: period.end,
              type: typeFilter,
              categoryId: catFilter === 'all' ? 'all' : Number(catFilter),
            }),
        // GET /transfers has no date-range filter; clip to the period here.
        api.transfers.list(),
      ]);
      if (seq !== reqSeq.current) return; // superseded — drop stale result
      setTxs(t);
      setTransfers(allTransfers.filter((tr) => tr.date >= period.start && tr.date <= period.end));
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

  const removeTransfer = async (tr: Transfer) => {
    const ok = await confirm({
      title: 'Delete transfer',
      message: `Delete this transfer of ${fmtMoney(tr.amountCents)}? Both account balances update.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.transfers.remove(tr.id);
      afterMutation();
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  // Payment = money sent to a debt account; Borrowed = money taken out of a
  // loan. Falls back to "Transfer" (incl. when an account was deleted).
  const accountType = (id: number | null) => accounts.find((a) => a.id === id)?.type;
  const transferBadge = (tr: Transfer): string => {
    const to = accountType(tr.toAccountId);
    if (to === 'credit' || to === 'loan') return 'Payment';
    if (accountType(tr.fromAccountId) === 'loan') return 'Borrowed';
    return 'Transfer';
  };

  // Export / totals cover the full matched set (all pages, after search), not
  // just the current page. Totals count REAL income/spending only — transfers
  // and payments move money between the user's own accounts.
  const matched = paged.matched;
  const exportCsv = () => {
    downloadFile(
      `transactions-${period.start}_${period.end}.csv`,
      rowsToCsv(matched),
      'text/csv;charset=utf-8'
    );
    setNotice(`Exported ${matched.length} ${matched.length === 1 ? 'entry' : 'entries'}`);
    setTimeout(() => setNotice(''), 4000);
  };

  const incomeTotal = matched
    .filter((r): r is Row & { kind: 'tx' } => r.kind === 'tx' && r.t.type === 'income')
    .reduce((s, r) => s + r.t.amountCents, 0);
  const expenseTotal = matched
    .filter((r): r is Row & { kind: 'tx' } => r.kind === 'tx' && r.t.type === 'expense')
    .reduce((s, r) => s + r.t.amountCents, 0);

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
          <button className="btn" onClick={exportCsv} disabled={matched.length === 0}>
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
          onChange={(e) => setTypeFilter(e.target.value as TxType | 'all' | 'transfer')}
        >
          <option value="all">All types</option>
          <option value="income">Income</option>
          <option value="expense">Expenses</option>
          <option value="transfer">Transfers &amp; payments</option>
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
          {ROW_SORTS.map((o) => (
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

      {/* Period totals for the current filter/search — same stat cards as the
          dashboard. Transfers/payments are listed below but never counted here. */}
      {loaded && (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-label">Income</div>
            <div className="stat-value green">{fmtMoney(incomeTotal)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Expenses</div>
            <div className="stat-value red">{fmtMoney(expenseTotal)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Net</div>
            <div className={`stat-value ${incomeTotal - expenseTotal >= 0 ? 'green' : 'red'}`}>
              {fmtMoney(incomeTotal - expenseTotal)}
            </div>
          </div>
        </div>
      )}

      {!loaded ? (
        <div className="empty-state">Loading…</div>
      ) : paged.matchedCount === 0 ? (
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
              {paged.visible.map((r) =>
                r.kind === 'tx' ? (
                  <tr key={`tx-${r.t.id}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {dateLabel(r.t.date)}
                      {r.t.time && <span className="time-dim"> · {timeLabel(r.t.time)}</span>}
                    </td>
                    <td>
                      <span className="chip-stack">
                        <span className="cat-chip">
                          <span
                            className="color-dot"
                            style={{ background: r.t.categoryColor ?? '#64748b' }}
                          />
                          <span>{r.t.categoryName ?? 'Uncategorized'}</span>
                        </span>
                        {r.t.accountName && (
                          <span
                            className="cat-chip account-chip"
                            title={`Account: ${r.t.accountName}`}
                          >
                            <span
                              className="color-dot"
                              style={{ background: r.t.accountColor ?? '#64748b' }}
                            />
                            <span>{r.t.accountName}</span>
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="note-cell">{r.t.note}</td>
                    <td className={`num amount-${r.t.type}`}>
                      {fmtSigned(r.t.amountCents, r.t.type)}
                    </td>
                    <td className="actions">
                      <button
                        className="btn-icon"
                        title="Edit"
                        onClick={() => setModal({ open: true, editing: r.t })}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        className="btn-icon danger"
                        title="Delete"
                        onClick={() => remove(r.t)}
                      >
                        <TrashIcon />
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={`tr-${r.tr.id}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {dateLabel(r.tr.date)}
                      {r.tr.time && <span className="time-dim"> · {timeLabel(r.tr.time)}</span>}
                    </td>
                    <td>
                      <span className="chip-stack">
                        <span className="cat-chip">
                          <TransferIcon size={13} />
                          <span>{transferBadge(r.tr)}</span>
                        </span>
                        <span
                          className="cat-chip account-chip"
                          title={`${r.tr.fromName ?? 'Deleted account'} → ${r.tr.toName ?? 'Deleted account'}`}
                        >
                          <span
                            className="color-dot"
                            style={{ background: r.tr.fromColor ?? '#64748b' }}
                          />
                          <span>{r.tr.fromName ?? 'Deleted account'}</span>
                          <span aria-hidden="true"> → </span>
                          <span
                            className="color-dot"
                            style={{ background: r.tr.toColor ?? '#64748b' }}
                          />
                          <span>{r.tr.toName ?? 'Deleted account'}</span>
                        </span>
                      </span>
                    </td>
                    <td className="note-cell">
                      {r.tr.note}
                      {r.tr.feeCents > 0 && (
                        <span style={{ color: 'var(--text-faint)' }}>
                          {r.tr.note ? ' · ' : ''}fee {fmtMoney(r.tr.feeCents)}
                        </span>
                      )}
                    </td>
                    {/* Cash perspective: a Payment drains spendable money (red −),
                        a Borrow adds to it (green +); a plain move stays neutral. */}
                    <td
                      className={`num ${
                        transferBadge(r.tr) === 'Payment'
                          ? 'amount-expense'
                          : transferBadge(r.tr) === 'Borrowed'
                            ? 'amount-income'
                            : ''
                      }`}
                    >
                      {transferBadge(r.tr) === 'Payment'
                        ? '−'
                        : transferBadge(r.tr) === 'Borrowed'
                          ? '+'
                          : ''}
                      {fmtMoney(r.tr.amountCents)}
                    </td>
                    <td className="actions">
                      <button
                        className="btn-icon"
                        title="Edit"
                        onClick={() => setTransferModal({ open: true, editing: r.tr })}
                        disabled={r.tr.fromAccountId === null || r.tr.toAccountId === null}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        className="btn-icon danger"
                        title="Delete"
                        onClick={() => removeTransfer(r.tr)}
                      >
                        <TrashIcon />
                      </button>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
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
      {transferModal.open && (
        <TransferModal
          initial={transferModal.editing}
          accounts={accounts}
          onClose={() => setTransferModal({ open: false, editing: null })}
          onSaved={afterMutation}
        />
      )}
    </div>
  );
}
