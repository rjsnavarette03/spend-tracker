import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Transaction, Transfer } from '../../shared/types';
import { api } from '../api';
import { useAppContext } from '../App';
import { AccountEditModal } from '../components/AccountEditModal';
import { PayModal } from '../components/PayModal';
import { TransactionModal } from '../components/TransactionModal';
import { TransferModal } from '../components/TransferModal';
import { PencilIcon, TrashIcon } from '../components/Icons';
import { cleanError, dateLabel, fmtMoney } from '../format';
import { confirm, toast } from '../components/feedback';

const TYPE_LABELS: Record<string, string> = {
  debit: 'Debit',
  credit: 'Credit',
  loan: 'Loan / Borrowed',
};

export function AccountDetail() {
  const { period, categories, accounts, onDataChanged } = useAppContext();
  const params = useParams();
  const id = Number(params.id);
  const account = accounts.find((a) => a.id === id) ?? null;

  const [txs, setTxs] = useState<Transaction[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [txModal, setTxModal] = useState<{ open: boolean; editing: Transaction | null }>({
    open: false,
    editing: null,
  });
  const [transferModal, setTransferModal] = useState<{ open: boolean; editing: Transfer | null }>({
    open: false,
    editing: null,
  });
  const [editOpen, setEditOpen] = useState(false);

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
            Edit
          </button>
          {/* Debit & credit can add a transaction (credit = expense/purchase only,
              wired below); loans are managed purely via Pay. */}
          {account.type !== 'loan' && (
            <button
              className={account.type === 'debit' ? 'btn btn-primary' : 'btn'}
              onClick={() => setTxModal({ open: true, editing: null })}
            >
              Add transaction
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
              Pay
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
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-title">Transactions</div>
        {!loaded ? (
          <div className="empty-state">Loading…</div>
        ) : txs.length === 0 ? (
          <div className="empty-state">No transactions linked to this account yet.</div>
        ) : (
          /* tx-cards: ≤860px CSS restacks each row into a native-app list card */
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
        )}
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-title">Transfers &amp; payments</div>
        {!loaded ? (
          <div className="empty-state">Loading…</div>
        ) : transfers.length === 0 ? (
          <div className="empty-state">No transfers or payments involving this account yet.</div>
        ) : (
          /* detail-transfers: ≤860px CSS restacks rows into list cards */
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
              {transfers.map((tr) => {
                const incoming = tr.toAccountId === id;
                // What actually moves for THIS account: incoming = +amount;
                // outgoing = −(amount + fee), since the fee also leaves the source.
                const delta = incoming ? tr.amountCents : -(tr.amountCents + tr.feeCents);
                const other = incoming
                  ? tr.fromName ?? 'Deleted account'
                  : tr.toName ?? 'Deleted account';
                return (
                  <tr key={tr.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{dateLabel(tr.date)}</td>
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
