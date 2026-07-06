import { useCallback, useEffect, useState } from 'react';
import type { Account, AccountType, Transfer } from '../../shared/types';
import { api } from '../api';
import { confirm, toast } from '../components/feedback';
import { AccountEditModal } from '../components/AccountEditModal';
import { PencilIcon, PlusIcon, TransferIcon, TrashIcon } from '../components/Icons';
import { TransferModal } from '../components/TransferModal';
import { cleanError, dateLabel, fmtMoney } from '../format';

const SECTIONS: Array<{ type: AccountType; title: string; hint: string }> = [
  { type: 'debit', title: 'Debit', hint: 'Cash, banks & e-wallets' },
  { type: 'credit', title: 'Credit', hint: 'Credit cards' },
  { type: 'loan', title: 'Loans / Borrowed', hint: 'Money owed to others' },
];

export function Accounts({
  accounts,
  onDataChanged,
}: {
  accounts: Account[];
  onDataChanged: () => void;
}) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [accountModal, setAccountModal] = useState<{ open: boolean; editing: Account | null }>({
    open: false,
    editing: null,
  });
  const [transferModal, setTransferModal] = useState<{ open: boolean; editing: Transfer | null }>({
    open: false,
    editing: null,
  });

  const loadTransfers = useCallback(async () => {
    try {
      setTransfers(await api.transfers.list());
    } catch (err) {
      toast.error(cleanError(err));
    }
  }, []);

  useEffect(() => {
    void loadTransfers();
  }, [loadTransfers]);

  const afterMutation = () => {
    void loadTransfers();
    onDataChanged();
  };

  const removeAccount = async (a: Account) => {
    const usage: string[] = [];
    if (a.txCount > 0) usage.push(`${a.txCount} transaction${a.txCount === 1 ? '' : 's'}`);
    if (a.transferCount > 0)
      usage.push(`${a.transferCount} transfer${a.transferCount === 1 ? '' : 's'}`);
    const message =
      usage.length > 0
        ? `${usage.join(' and ')} will keep their history but lose the link to this account.`
        : 'This account will be removed.';
    const ok = await confirm({
      title: `Delete "${a.name}"?`,
      message,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.accounts.remove(a.id);
      afterMutation();
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  const removeTransfer = async (t: Transfer) => {
    const ok = await confirm({
      title: 'Delete transfer',
      message: `Delete this transfer of ${fmtMoney(t.amountCents)}?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.transfers.remove(t.id);
      afterMutation();
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  // Net worth by balance sign: positive balances are assets, negative are
  // liabilities (debts). Net worth = assets − liabilities = sum of balances.
  // Transfers move money between debit accounts only.
  const debitCount = accounts.filter((a) => a.type === 'debit').length;
  const assets = accounts.filter((a) => a.balanceCents > 0).reduce((s, a) => s + a.balanceCents, 0);
  const liabilities = accounts
    .filter((a) => a.balanceCents < 0)
    .reduce((s, a) => s - a.balanceCents, 0);
  const netWorth = assets - liabilities;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Accounts</h1>
          <div className="page-sub">Track where your money lives</div>
        </div>
        <div className="head-actions">
          <button
            className="btn"
            onClick={() => setTransferModal({ open: true, editing: null })}
            disabled={debitCount < 2}
            title={debitCount < 2 ? 'You need at least two debit accounts to transfer' : undefined}
          >
            <TransferIcon /> Transfer
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setAccountModal({ open: true, editing: null })}
          >
            <PlusIcon /> Add account
          </button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="empty-state">
          No accounts yet. Add your bank accounts, e-wallets, credit cards and loans — expenses
          and income can then be tied to an account, and balances update automatically.
          <br />
          <button
            className="btn btn-primary"
            onClick={() => setAccountModal({ open: true, editing: null })}
          >
            <PlusIcon /> Add your first account
          </button>
        </div>
      ) : (
        <>
          <div className="panel networth-card">
            <div className="networth-main">
              <div className="networth-label">Net Worth</div>
              <div className={`networth-value ${netWorth >= 0 ? 'green' : 'red'}`}>
                {fmtMoney(netWorth)}
              </div>
            </div>
            <div className="networth-split">
              <div className="networth-item">
                <span className="networth-item-label">Assets</span>
                <span className="networth-item-value amount-income">{fmtMoney(assets)}</span>
              </div>
              <div className="networth-divider" />
              <div className="networth-item">
                <span className="networth-item-label">Liabilities</span>
                <span className="networth-item-value amount-expense">{fmtMoney(liabilities)}</span>
              </div>
            </div>
          </div>

          <div className="accounts-grid">
            {SECTIONS.map(({ type, title, hint }) => {
            const items = accounts.filter((a) => a.type === type);
            if (items.length === 0) return null;
            const subtotal = items.reduce((s, a) => s + a.balanceCents, 0);
            return (
              <div className="panel" key={type}>
                <div className="section-title">
                  <span>
                    {title} <span className="section-hint">{hint}</span>
                  </span>
                  <span className={`num ${subtotal < 0 ? 'amount-expense' : ''}`}>
                    {fmtMoney(subtotal)}
                  </span>
                </div>
                <table className="table">
                  <tbody>
                    {items.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <span className="cat-chip">
                            {a.image ? (
                              <img className="acct-avatar" src={a.image} alt="" />
                            ) : (
                              <span className="color-dot" style={{ background: a.color }} />
                            )}
                            <span>{a.name}</span>
                          </span>
                        </td>
                        <td className={`num ${a.balanceCents < 0 ? 'amount-expense' : 'amount-income'}`}>
                          {fmtMoney(a.balanceCents)}
                          {a.balanceCents < 0 && <span className="owed-tag"> owed</span>}
                        </td>
                        <td className="actions">
                          <button
                            className="btn-icon"
                            title="Edit"
                            onClick={() => setAccountModal({ open: true, editing: a })}
                          >
                            <PencilIcon />
                          </button>
                          <button
                            className="btn-icon danger"
                            title="Delete"
                            onClick={() => removeAccount(a)}
                          >
                            <TrashIcon />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          </div>
        </>
      )}

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-title">Transfers</div>
        {transfers.length === 0 ? (
          <div className="empty-state">
            No transfers yet. Move money between accounts — with an optional fee — and both
            balances update automatically.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>From → To</th>
                <th>Note</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th style={{ textAlign: 'right' }}>Fee</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dateLabel(t.date)}</td>
                  <td>
                    <span className="transfer-route">
                      <span className="cat-chip">
                        <span
                          className="color-dot"
                          style={{ background: t.fromColor ?? '#64748b' }}
                        />
                        <span>{t.fromName ?? 'Deleted account'}</span>
                      </span>
                      <span className="transfer-arrow">→</span>
                      <span className="cat-chip">
                        <span className="color-dot" style={{ background: t.toColor ?? '#64748b' }} />
                        <span>{t.toName ?? 'Deleted account'}</span>
                      </span>
                    </span>
                  </td>
                  <td className="note-cell">{t.note}</td>
                  <td className="num">{fmtMoney(t.amountCents)}</td>
                  <td className="num" style={{ color: t.feeCents > 0 ? 'var(--red)' : 'var(--text-faint)' }}>
                    {t.feeCents > 0 ? fmtMoney(t.feeCents) : '—'}
                  </td>
                  <td className="actions">
                    <button
                      className="btn-icon"
                      title="Edit"
                      onClick={() => setTransferModal({ open: true, editing: t })}
                      disabled={t.fromAccountId === null || t.toAccountId === null}
                    >
                      <PencilIcon />
                    </button>
                    <button
                      className="btn-icon danger"
                      title="Delete"
                      onClick={() => removeTransfer(t)}
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

      {accountModal.open && (
        <AccountEditModal
          initial={accountModal.editing}
          onClose={() => setAccountModal({ open: false, editing: null })}
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
