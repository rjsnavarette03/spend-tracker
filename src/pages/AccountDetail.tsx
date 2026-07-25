import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Transaction, Transfer } from '../../shared/types';
import { api } from '../api';
import { useAppContext } from '../App';
import { AccountEditModal } from '../components/AccountEditModal';
import { BorrowModal } from '../components/BorrowModal';
import { DueTag } from '../components/DueTag';
import { PayModal } from '../components/PayModal';
import { TransactionModal } from '../components/TransactionModal';
import { TransferModal } from '../components/TransferModal';
import { Pager } from '../components/Pager';
import {
  BanknoteIcon,
  CoinsIcon,
  PencilIcon,
  PlusIcon,
  TransferIcon,
  TrashIcon,
} from '../components/Icons';
import { cleanError, dateLabel, fmtMoney, timeLabel } from '../format';
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

export function AccountDetail() {
  const { period, categories, accounts, onDataChanged } = useAppContext();
  const params = useParams();
  const navigate = useNavigate();
  const id = Number(params.id);
  const account = accounts.find((a) => a.id === id) ?? null;

  const [txs, setTxs] = useState<Transaction[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
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

  const pagedTxs = usePagedTable(txs, DETAIL_TX_SEARCH, DETAIL_TX_SORTS, {
    initialSort: 'date-desc',
  });
  const pagedTransfers = usePagedTable(transfers, DETAIL_TRANSFER_SEARCH, DETAIL_TRANSFER_SORTS, {
    initialSort: 'date-desc',
  });

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [t, allTransfers] = await Promise.all([
        api.transactions.list({ accountId: id }),
        api.transfers.list(),
      ]);
      setTxs(t);
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

  const removeTransfer = async (tr: Transfer) => {
    const ok = await confirm({
      title: 'Delete transfer',
      message: `Delete this transfer of ${fmtMoney(tr.amountCents)}?`,
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

  const removeAccount = async () => {
    if (!account) return;
    const usage: string[] = [];
    if (account.txCount > 0)
      usage.push(`${account.txCount} transaction${account.txCount === 1 ? '' : 's'}`);
    if (account.transferCount > 0)
      usage.push(`${account.transferCount} transfer${account.transferCount === 1 ? '' : 's'}`);
    const message =
      usage.length > 0
        ? `${usage.join(' and ')} will keep their history but lose the link to this account.`
        : 'This account will be removed.';
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
    (a) => a.id !== account.id && (a.type === 'debit' || a.type === 'credit')
  );
  // A transfer from this debit account needs another debit account to land in.
  const otherDebits = accounts.filter((a) => a.type === 'debit' && a.id !== account.id);
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
      </div>

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
                const other = incoming
                  ? tr.fromName ?? 'Deleted account'
                  : tr.toName ?? 'Deleted account';
                return (
                  <tr key={tr.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {dateLabel(tr.date)}
                      {tr.time && <span className="time-dim"> · {timeLabel(tr.time)}</span>}
                    </td>
                    <td>
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
