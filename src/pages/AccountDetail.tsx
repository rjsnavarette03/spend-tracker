import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Adjustment, Transaction, Transfer } from '../../shared/types';
import { archivedOnLabel, isArchived } from '../accounts';
import { api } from '../api';
import { useAppContext } from '../App';
import { AccountEditModal } from '../components/AccountEditModal';
import { AdjustmentModal, adjustmentReasonLabel } from '../components/AdjustmentModal';
import { BorrowModal } from '../components/BorrowModal';
import { CreditUsage } from '../components/CreditUsage';
import { DueTag } from '../components/DueTag';
import { PayModal } from '../components/PayModal';
import { TransactionModal } from '../components/TransactionModal';
import { TransferModal } from '../components/TransferModal';
import { Pager } from '../components/Pager';
import {
  ArchiveIcon,
  BanknoteIcon,
  CoinsIcon,
  PencilIcon,
  PlusIcon,
  RestoreIcon,
  SlidersIcon,
  TransferIcon,
  TrashIcon,
} from '../components/Icons';
import { cleanError, dateLabel, fmtMoney, fmtRate, nextMonthlyDate, ordinal, timeLabel } from '../format';
import { confirm, toast } from '../components/feedback';
import { usePagedTable } from '../usePagedTable';
import type { SortOption } from '../usePagedTable';

const TYPE_LABELS: Record<string, string> = {
  debit: 'Debit',
  credit: 'Credit',
  loan: 'Loan / Borrowed',
};

// This account's transactions: search matches note + category (the account is
// fixed here, so it isn't part of the search). Sort choices bake in direction.
const DETAIL_TX_SEARCH = (t: Transaction) => `${t.note} ${t.categoryName ?? ''}`;
const DETAIL_TX_SORTS: SortOption<Transaction>[] = [
  {
    value: 'date-desc',
    label: 'Date (newest)',
    compare: (a, b) =>
      b.date.localeCompare(a.date) ||
      (b.time ?? '').localeCompare(a.time ?? '') ||
      b.id - a.id,
  },
  {
    value: 'date-asc',
    label: 'Date (oldest)',
    compare: (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time ?? '').localeCompare(b.time ?? '') ||
      a.id - b.id,
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

// Transfers & payments involving this account: search matches note + the other
// account names.
const DETAIL_TRANSFER_SEARCH = (t: Transfer) => `${t.note} ${t.fromName ?? ''} ${t.toName ?? ''}`;
const DETAIL_TRANSFER_SORTS: SortOption<Transfer>[] = [
  {
    value: 'date-desc',
    label: 'Date (newest)',
    compare: (a, b) =>
      b.date.localeCompare(a.date) ||
      (b.time ?? '').localeCompare(a.time ?? '') ||
      b.id - a.id,
  },
  {
    value: 'date-asc',
    label: 'Date (oldest)',
    compare: (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time ?? '').localeCompare(b.time ?? '') ||
      a.id - b.id,
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
];

// Credit cards get ONE merged ledger (purchases + payments + adjustments)
// instead of a separate transfers table — every transfer touching a card IS a
// payment.
type Row =
  | { kind: 'tx'; t: Transaction }
  | { kind: 'transfer'; tr: Transfer }
  | { kind: 'adj'; a: Adjustment };
const rowEntry = (r: Row) => (r.kind === 'tx' ? r.t : r.kind === 'transfer' ? r.tr : r.a);
const rowDate = (r: Row) => rowEntry(r).date;
const rowTime = (r: Row) => rowEntry(r).time ?? '';
const rowId = (r: Row) => rowEntry(r).id;
const rowAmount = (r: Row) => Math.abs(rowEntry(r).amountCents);
const ROW_SEARCH = (r: Row) =>
  r.kind === 'tx'
    ? `${r.t.note} ${r.t.categoryName ?? ''}`
    : r.kind === 'transfer'
      ? `payment ${r.tr.note} ${r.tr.fromName ?? ''} ${r.tr.toName ?? ''}`
      : `adjustment ${adjustmentReasonLabel(r.a.reason)} ${r.a.note}`;
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
];

export function AccountDetail() {
  const { period, categories, accounts, onDataChanged } = useAppContext();
  const params = useParams();
  const navigate = useNavigate();
  const id = Number(params.id);
  const account = accounts.find((a) => a.id === id) ?? null;

  const [txs, setTxs] = useState<Transaction[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [borrowOpen, setBorrowOpen] = useState(false);
  const [txModal, setTxModal] = useState<{ open: boolean; editing: Transaction | null }>({
    open: false,
    editing: null,
  });
  const [transferModal, setTransferModal] = useState<{ open: boolean; editing: Transfer | null }>({
    open: false,
    editing: null,
  });
  const [editOpen, setEditOpen] = useState(false);
  const [adjModal, setAdjModal] = useState<{ open: boolean; editing: Adjustment | null }>({
    open: false,
    editing: null,
  });

  const pagedTxs = usePagedTable(txs, DETAIL_TX_SEARCH, DETAIL_TX_SORTS, {
    initialSort: 'date-desc',
  });
  const pagedTransfers = usePagedTable(transfers, DETAIL_TRANSFER_SEARCH, DETAIL_TRANSFER_SORTS, {
    initialSort: 'date-desc',
  });
  // Merged ledger for credit accounts (built unconditionally — hooks can't
  // live behind the account-type branch).
  const rows = useMemo<Row[]>(
    () => [
      ...txs.map((t): Row => ({ kind: 'tx', t })),
      ...transfers.map((tr): Row => ({ kind: 'transfer', tr })),
      ...adjustments.map((a): Row => ({ kind: 'adj', a })),
    ],
    [txs, transfers, adjustments]
  );
  const pagedRows = usePagedTable(rows, ROW_SEARCH, ROW_SORTS, {
    initialSort: 'date-desc',
  });

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [t, allTransfers, adj] = await Promise.all([
        api.transactions.list({ accountId: id }),
        api.transfers.list(),
        api.adjustments.list(id), // always [] on debit and loan accounts
      ]);
      setTxs(t);
      setAdjustments(adj);
      setTransfers(
        allTransfers.filter((tr) => tr.fromAccountId === id || tr.toAccountId === id)
      );
      setLoaded(true);
    } catch (err) {
      toast.error(cleanError(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterMutation = () => {
    void load();
    onDataChanged();
  };

  const removeTx = async (t: Transaction) => {
    const ok = await confirm({
      title: 'Delete transaction',
      message: `Delete this ${t.type} of ${fmtMoney(t.amountCents)}?`,
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

  // On credit accounts every transfer row is a payment — the confirm dialog
  // should say so instead of "transfer".
  const removeTransfer = async (tr: Transfer, noun: 'transfer' | 'payment' = 'transfer') => {
    const ok = await confirm({
      title: noun === 'payment' ? 'Delete payment' : 'Delete transfer',
      message: `Delete this ${noun} of ${fmtMoney(tr.amountCents)}?`,
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

  const removeAdjustment = async (a: Adjustment) => {
    const ok = await confirm({
      title: 'Delete adjustment',
      message: `Delete this adjustment of ${fmtMoney(Math.abs(a.amountCents))} (${adjustmentReasonLabel(
        a.reason
      )})? The card's balance goes back by that much.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.adjustments.remove(a.id);
      afterMutation();
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  const removeAccount = async () => {
    if (!account) return;
    const usage: string[] = [];
    if (account.txCount > 0)
      usage.push(`${account.txCount} transaction${account.txCount === 1 ? '' : 's'}`);
    if (account.transferCount > 0)
      usage.push(`${account.transferCount} transfer${account.transferCount === 1 ? '' : 's'}`);
    // Settled with history: point at Archive, which keeps the links.
    const archiveHint =
      usage.length > 0 && account.balanceCents === 0 && account.archivedAt === null
        ? ' To keep them linked, archive the account instead.'
        : '';
    // Adjustments only mean something on their card, so they go with it.
    const adjNote =
      adjustments.length > 0
        ? ` Its ${adjustments.length} adjustment${adjustments.length === 1 ? '' : 's'} will be deleted with it.`
        : '';
    const message =
      (usage.length > 0
        ? `${usage.join(' and ')} will keep their history but lose the link to this account.${archiveHint}`
        : 'This account will be removed.') + adjNote;
    const ok = await confirm({
      title: `Delete "${account.name}"?`,
      message,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.accounts.remove(account.id);
      navigate('/accounts'); // leave the now-deleted detail page
      onDataChanged(); // refresh the shared accounts list
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  // A settled account can be archived: off the account lists and pickers,
  // history untouched. The server pauses Schedule plans that pay into it, so
  // the dialog names them first.
  const archiveAccount = async () => {
    if (!account) return;
    let plans: string[] = [];
    try {
      plans = (await api.schedule.get()).items
        .filter((i) => i.active && i.accountId === account.id)
        .map((i) => i.name);
    } catch {
      // the dialog just can't name them; the toast still will
    }
    const ok = await confirm({
      title: `Archive "${account.name}"?`,
      message:
        'It moves to Archived on the Accounts page and leaves the account pickers. Its history stays ' +
        `exactly as it is, and recording anything new on it${account.type === 'loan' ? ', like Borrow again,' : ''} ` +
        'brings it back.' +
        (plans.length > 0 ? ` The Schedule's plan for it (${plans.join(', ')}) will be paused.` : ''),
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    try {
      const r = await api.accounts.archive(account.id);
      toast.success(
        r.pausedItems.length > 0
          ? `Archived ${account.name} · paused in the Schedule: ${r.pausedItems.join(', ')}`
          : `Archived ${account.name}`
      );
      navigate('/accounts'); // where it now sits under Archived
      onDataChanged();
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  const restoreAccount = async () => {
    if (!account) return;
    try {
      await api.accounts.restore(account.id);
      toast.success(`Restored ${account.name}`);
      onDataChanged();
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  // accounts are loaded by the layout; once present, a missing one is a real 404.
  if (accounts.length > 0 && !account) {
    return (
      <div>
        <Link className="back-link" to="/accounts">
          ← Accounts
        </Link>
        <div className="empty-state">That account doesn't exist.</div>
      </div>
    );
  }
  if (!account) {
    return <div className="empty-state">Loading…</div>;
  }

  const paySources = accounts.filter(
    (a) => a.id !== account.id && (a.type === 'debit' || a.type === 'credit') && !isArchived(a)
  );
  // A transfer from this debit account needs another debit account to land in.
  const otherDebits = accounts.filter((a) => a.type === 'debit' && a.id !== account.id && !isArchived(a));
  const negative = account.balanceCents < 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <Link className="back-link" to="/accounts">
            ← Accounts
          </Link>
          <h1 className="page-title account-detail-title">
            {account.image ? (
              <img className="acct-avatar" src={account.image} alt="" />
            ) : (
              <span className="color-dot" style={{ background: account.color }} />
            )}
            {account.name}
          </h1>
          <div className="page-sub">{TYPE_LABELS[account.type] ?? account.type}</div>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => setEditOpen(true)}>
            <PencilIcon /> Edit
          </button>
          {account.archivedAt !== null ? (
            <button className="btn" onClick={() => void restoreAccount()}>
              <RestoreIcon /> Restore
            </button>
          ) : (
            // Only once settled: archiving never hides money or debt.
            account.balanceCents === 0 && (
              <button
                className="btn"
                onClick={() => void archiveAccount()}
                title="Put this settled account away; its history stays"
              >
                <ArchiveIcon /> Archive
              </button>
            )
          )}
          <button className="btn btn-danger" onClick={() => void removeAccount()}>
            <TrashIcon /> Delete
          </button>
          {account.type === 'debit' && (
            <button
              className="btn"
              onClick={() => setTransferModal({ open: true, editing: null })}
              disabled={otherDebits.length === 0}
              title={
                otherDebits.length === 0
                  ? 'Add another debit account to transfer to'
                  : undefined
              }
            >
              <TransferIcon /> Transfer
            </button>
          )}
          {/* Debit & credit can add a transaction (credit = expense/purchase only,
              wired below); loans are managed purely via Pay. */}
          {account.type !== 'loan' && (
            <button
              className={account.type === 'debit' ? 'btn btn-primary' : 'btn'}
              onClick={() => setTxModal({ open: true, editing: null })}
            >
              <PlusIcon /> Add transaction
            </button>
          )}
          {/* The deposit account is optional (the modal can just grow the
              debt), so this works even with no debit account. */}
          {account.type === 'loan' && (
            <button className="btn" onClick={() => setBorrowOpen(true)}>
              <CoinsIcon size={16} /> Borrow again
            </button>
          )}
          {/* Points used, a refund that came back different, an installment
              conversion fee: balance changes that aren't purchases or payments. */}
          {account.type === 'credit' && (
            <button
              className="btn"
              onClick={() => setAdjModal({ open: true, editing: null })}
              title="Points used, a refund difference or a fee: change the balance without a purchase or payment"
            >
              <SlidersIcon size={16} /> Adjust
            </button>
          )}
          {account.type !== 'debit' && (
            <button
              className="btn btn-primary"
              onClick={() => setPayOpen(true)}
              disabled={paySources.length === 0}
              title={
                paySources.length === 0
                  ? 'Add a debit or credit account to pay from'
                  : undefined
              }
            >
              <BanknoteIcon /> Pay
            </button>
          )}
        </div>
      </div>

      {isArchived(account) && (
        <div className="archived-banner" role="status">
          <ArchiveIcon size={16} />
          <span>
            Archived {archivedOnLabel(account)}. It's hidden from your accounts and account pickers, and its
            history is unchanged. Recording anything new on it
            {account.type === 'loan' ? ', like Borrow again,' : ''} brings it back.
          </span>
        </div>
      )}

      <div className="panel account-balance-card">
        <span className="account-balance-label">
          {negative ? 'Currently owed' : 'Current balance'}
        </span>
        <span className={`account-balance-value ${negative ? 'amount-expense' : 'amount-income'}`}>
          {fmtMoney(Math.abs(account.balanceCents))}
        </span>
        {account.dueDay != null && negative && (
          <span className="due-line">
            <DueTag dueDay={account.dueDay} dueDay2={account.dueDay2} />
          </span>
        )}
        {account.type === 'credit' && account.creditLimitCents !== null && (
          <CreditUsage balanceCents={account.balanceCents} limitCents={account.creditLimitCents} />
        )}
        {(account.statementDay !== null || account.interestRateBp !== null) && (
          <span className="account-terms">
            {account.statementDay !== null && (
              <span title={`The statement closes on the ${ordinal(account.statementDay)} of every month`}>
                Statement closes {nextMonthlyDate(account.statementDay).label}
              </span>
            )}
            {account.interestRateBp !== null && (
              <span>
                Interest {fmtRate(account.interestRateBp)} a year ({fmtRate(Math.round(account.interestRateBp / 12))} a month)
              </span>
            )}
          </span>
        )}
      </div>

      {account.type === 'credit' ? (
        /* Credit cards: purchases and payments are one story, and plain
           transfers don't apply — one merged ledger replaces the two tables. */
        <div className="panel mt-panel">
          <div className="panel-head">
            <div className="panel-title">Transactions &amp; payments</div>
            {rows.length > 0 && (
              <div className="table-controls">
                <select
                  aria-label="Sort entries"
                  value={pagedRows.sort}
                  onChange={(e) => pagedRows.setSort(e.target.value)}
                >
                  {ROW_SORTS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  type="search"
                  placeholder="Search transactions…"
                  value={pagedRows.query}
                  onChange={(e) => pagedRows.setQuery(e.target.value)}
                />
              </div>
            )}
          </div>
          {!loaded ? (
            <div className="empty-state">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="empty-state">No transactions, payments or adjustments on this account yet.</div>
          ) : pagedRows.matchedCount === 0 ? (
            <div className="empty-state">Nothing matches your search.</div>
          ) : (
            /* tx-cards: ≤860px CSS restacks each row into a native-app list card */
            <>
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
                {pagedRows.visible.map((r) => {
                  if (r.kind === 'tx') {
                    const t = r.t;
                    return (
                      <tr key={`tx-${t.id}`}>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {dateLabel(t.date)}
                          {t.time && <span className="time-dim"> · {timeLabel(t.time)}</span>}
                        </td>
                        <td>
                          <span className="cat-chip">
                            <span
                              className="color-dot"
                              style={{ background: t.categoryColor ?? '#64748b' }}
                            />
                            <span>{t.categoryName ?? 'Uncategorized'}</span>
                          </span>
                          {t.splitGroup != null && <span className="split-tag" title="Part of a split receipt">Split</span>}
                        </td>
                        <td className="note-cell">{t.note}</td>
                        <td className={`num ${t.type === 'income' ? 'amount-income' : 'amount-expense'}`}>
                          {t.type === 'income' ? '+' : '−'}
                          {fmtMoney(t.amountCents)}
                        </td>
                        <td className="actions">
                          <button
                            className="btn-icon"
                            title="Edit"
                            onClick={() => setTxModal({ open: true, editing: t })}
                          >
                            <PencilIcon />
                          </button>
                          <button
                            className="btn-icon danger"
                            title="Delete"
                            onClick={() => removeTx(t)}
                          >
                            <TrashIcon />
                          </button>
                        </td>
                      </tr>
                    );
                  }
                  if (r.kind === 'adj') {
                    const a = r.a;
                    return (
                      <tr key={`adj-${a.id}`}>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {dateLabel(a.date)}
                          {a.time && <span className="time-dim"> · {timeLabel(a.time)}</span>}
                        </td>
                        <td>
                          <span className="cat-chip" title="Changes the balance only, not income or spending">
                            <SlidersIcon size={13} />
                            <span>Adjustment</span>
                          </span>
                        </td>
                        <td className="note-cell">
                          {adjustmentReasonLabel(a.reason)}
                          {a.note ? ` · ${a.note}` : ''}
                        </td>
                        <td className={`num ${a.amountCents < 0 ? 'amount-expense' : 'amount-income'}`}>
                          {a.amountCents < 0 ? '−' : '+'}
                          {fmtMoney(Math.abs(a.amountCents))}
                        </td>
                        <td className="actions">
                          <button
                            className="btn-icon"
                            title="Edit"
                            onClick={() => setAdjModal({ open: true, editing: a })}
                          >
                            <PencilIcon />
                          </button>
                          <button
                            className="btn-icon danger"
                            title="Delete"
                            onClick={() => removeAdjustment(a)}
                          >
                            <TrashIcon />
                          </button>
                        </td>
                      </tr>
                    );
                  }
                  const tr = r.tr;
                  const incoming = tr.toAccountId === id;
                  // Card perspective: a payment received shrinks the debt (+);
                  // paying another debt FROM this card grows it (amount + fee).
                  const delta = incoming ? tr.amountCents : -(tr.amountCents + tr.feeCents);
                  const other = incoming
                    ? tr.fromName ?? 'Deleted account'
                    : tr.toName ?? 'Deleted account';
                  return (
                    <tr key={`tr-${tr.id}`}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {dateLabel(tr.date)}
                        {tr.time && <span className="time-dim"> · {timeLabel(tr.time)}</span>}
                      </td>
                      <td>
                        <span className="cat-chip">
                          <BanknoteIcon size={13} />
                          <span>Payment</span>
                        </span>
                      </td>
                      <td className="note-cell">
                        {incoming ? 'From ' : 'To '}
                        {other}
                        {tr.note ? ` · ${tr.note}` : ''}
                      </td>
                      <td className={`num ${delta < 0 ? 'amount-expense' : 'amount-income'}`}>
                        {delta < 0 ? '−' : '+'}
                        {fmtMoney(Math.abs(delta))}
                      </td>
                      <td className="actions">
                        <button
                          className="btn-icon"
                          title="Edit"
                          onClick={() => setTransferModal({ open: true, editing: tr })}
                          disabled={tr.fromAccountId === null || tr.toAccountId === null}
                        >
                          <PencilIcon />
                        </button>
                        <button
                          className="btn-icon danger"
                          title="Delete"
                          onClick={() => removeTransfer(tr, 'payment')}
                        >
                          <TrashIcon />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pager
              page={pagedRows.page}
              pageCount={pagedRows.pageCount}
              pageSize={pagedRows.pageSize}
              setPage={pagedRows.setPage}
              setPageSize={pagedRows.setPageSize}
              rangeStart={pagedRows.rangeStart}
              rangeEnd={pagedRows.rangeEnd}
              total={pagedRows.matchedCount}
              unit="entries"
            />
            </>
          )}
        </div>
      ) : (
        <>
          {/* Loans have no transactions (the form never offers them and the
              API rejects them) — everything lives in Transfers & payments. */}
          {account.type === 'debit' && (
          <div className="panel mt-panel">
            <div className="panel-head">
              <div className="panel-title">Transactions</div>
              {txs.length > 0 && (
                <div className="table-controls">
                  <select
                    aria-label="Sort transactions"
                    value={pagedTxs.sort}
                    onChange={(e) => pagedTxs.setSort(e.target.value)}
                  >
                    {DETAIL_TX_SORTS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="search"
                    placeholder="Search transactions…"
                    value={pagedTxs.query}
                    onChange={(e) => pagedTxs.setQuery(e.target.value)}
                  />
                </div>
              )}
            </div>
            {!loaded ? (
              <div className="empty-state">Loading…</div>
            ) : txs.length === 0 ? (
              <div className="empty-state">No transactions linked to this account yet.</div>
            ) : pagedTxs.matchedCount === 0 ? (
              <div className="empty-state">No transactions match your search.</div>
            ) : (
              /* tx-cards: ≤860px CSS restacks each row into a native-app list card */
              <>
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
                  {pagedTxs.visible.map((t) => (
                    <tr key={t.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {dateLabel(t.date)}
                        {t.time && <span className="time-dim"> · {timeLabel(t.time)}</span>}
                      </td>
                      <td>
                        <span className="cat-chip">
                          <span
                            className="color-dot"
                            style={{ background: t.categoryColor ?? '#64748b' }}
                          />
                          <span>{t.categoryName ?? 'Uncategorized'}</span>
                        </span>
                        {t.splitGroup != null && <span className="split-tag" title="Part of a split receipt">Split</span>}
                      </td>
                      <td className="note-cell">{t.note}</td>
                      <td className={`num ${t.type === 'income' ? 'amount-income' : 'amount-expense'}`}>
                        {t.type === 'income' ? '+' : '−'}
                        {fmtMoney(t.amountCents)}
                      </td>
                      <td className="actions">
                        <button
                          className="btn-icon"
                          title="Edit"
                          onClick={() => setTxModal({ open: true, editing: t })}
                        >
                          <PencilIcon />
                        </button>
                        <button
                          className="btn-icon danger"
                          title="Delete"
                          onClick={() => removeTx(t)}
                        >
                          <TrashIcon />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager
                page={pagedTxs.page}
                pageCount={pagedTxs.pageCount}
                pageSize={pagedTxs.pageSize}
                setPage={pagedTxs.setPage}
                setPageSize={pagedTxs.setPageSize}
                rangeStart={pagedTxs.rangeStart}
                rangeEnd={pagedTxs.rangeEnd}
                total={pagedTxs.matchedCount}
                unit="transactions"
              />
              </>
            )}
          </div>
          )}

          <div className="panel mt-panel">
            <div className="panel-head">
              <div className="panel-title">Transfers &amp; payments</div>
              {transfers.length > 0 && (
                <div className="table-controls">
                  <select
                    aria-label="Sort transfers"
                    value={pagedTransfers.sort}
                    onChange={(e) => pagedTransfers.setSort(e.target.value)}
                  >
                    {DETAIL_TRANSFER_SORTS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="search"
                    placeholder="Search transfers…"
                    value={pagedTransfers.query}
                    onChange={(e) => pagedTransfers.setQuery(e.target.value)}
                  />
                </div>
              )}
            </div>
            {!loaded ? (
              <div className="empty-state">Loading…</div>
            ) : transfers.length === 0 ? (
              <div className="empty-state">No transfers or payments involving this account yet.</div>
            ) : pagedTransfers.matchedCount === 0 ? (
              <div className="empty-state">No transfers match your search.</div>
            ) : (
              /* detail-transfers: ≤860px CSS restacks rows into list cards */
              <>
              <table className="table detail-transfers">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Details</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pagedTransfers.visible.map((tr) => {
                    const incoming = tr.toAccountId === id;
                    // What actually moves for THIS account: incoming = +amount;
                    // outgoing = −(amount + fee), since the fee also leaves the source.
                    const delta = incoming ? tr.amountCents : -(tr.amountCents + tr.feeCents);
                    // Loan borrows may have no destination ("just track what
                    // you owe") — the row is real, the money landed nowhere.
                    const route = incoming
                      ? `From ${tr.fromName ?? 'Deleted account'}`
                      : tr.toAccountId === null && account.type === 'loan'
                        ? 'Not deposited'
                        : `To ${tr.toName ?? 'Deleted account'}`;
                    return (
                      <tr key={tr.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {dateLabel(tr.date)}
                          {tr.time && <span className="time-dim"> · {timeLabel(tr.time)}</span>}
                        </td>
                        <td>
                          {route}
                          {tr.note ? ` · ${tr.note}` : ''}
                        </td>
                        <td className={`num ${delta < 0 ? 'amount-expense' : 'amount-income'}`}>
                          {delta < 0 ? '−' : '+'}
                          {fmtMoney(Math.abs(delta))}
                        </td>
                        <td className="actions">
                          <button
                            className="btn-icon"
                            title="Edit"
                            onClick={() => setTransferModal({ open: true, editing: tr })}
                            disabled={tr.fromAccountId === null || tr.toAccountId === null}
                          >
                            <PencilIcon />
                          </button>
                          <button
                            className="btn-icon danger"
                            title="Delete"
                            onClick={() => removeTransfer(tr)}
                          >
                            <TrashIcon />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Pager
                page={pagedTransfers.page}
                pageCount={pagedTransfers.pageCount}
                pageSize={pagedTransfers.pageSize}
                setPage={pagedTransfers.setPage}
                setPageSize={pagedTransfers.setPageSize}
                rangeStart={pagedTransfers.rangeStart}
                rangeEnd={pagedTransfers.rangeEnd}
                total={pagedTransfers.matchedCount}
                unit="transfers"
              />
              </>
            )}
          </div>
        </>
      )}

      {payOpen && (
        <PayModal
          account={account}
          accounts={accounts}
          onClose={() => setPayOpen(false)}
          onSaved={afterMutation}
        />
      )}
      {borrowOpen && (
        <BorrowModal
          account={account}
          accounts={accounts}
          onClose={() => setBorrowOpen(false)}
          onSaved={afterMutation}
        />
      )}
      {txModal.open && (
        <TransactionModal
          initial={txModal.editing}
          categories={categories}
          accounts={accounts}
          defaultMonth={period.start.slice(0, 7)}
          defaultAccountId={account.id}
          lockType={!txModal.editing && account.type === 'credit' ? 'expense' : undefined}
          onClose={() => setTxModal({ open: false, editing: null })}
          onSaved={afterMutation}
        />
      )}
      {transferModal.open && (
        <TransferModal
          initial={transferModal.editing}
          accounts={accounts}
          defaultFromAccountId={account.id}
          onClose={() => setTransferModal({ open: false, editing: null })}
          onSaved={afterMutation}
        />
      )}
      {adjModal.open && (
        <AdjustmentModal
          account={account}
          initial={adjModal.editing}
          onClose={() => setAdjModal({ open: false, editing: null })}
          onSaved={afterMutation}
        />
      )}
      {editOpen && (
        <AccountEditModal
          initial={account}
          onClose={() => setEditOpen(false)}
          onSaved={afterMutation}
        />
      )}
    </div>
  );
}
