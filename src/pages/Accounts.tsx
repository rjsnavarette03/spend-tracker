import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Account, AccountType, Transfer } from '../../shared/types';
import { api } from '../api';
import { confirm, toast } from '../components/feedback';
import { AccountEditModal } from '../components/AccountEditModal';
import { DueTag } from '../components/DueTag';
import { PencilIcon, PlusIcon, TransferIcon, TrashIcon } from '../components/Icons';
import { TransferModal } from '../components/TransferModal';
import { cleanError, dateLabel, fmtMoney } from '../format';

const SECTIONS: Array<{ type: AccountType; title: string; hint: string }> = [
  { type: 'debit', title: 'Debit', hint: 'Cash, banks & e-wallets' },
  { type: 'credit', title: 'Credit', hint: 'Credit cards' },
  { type: 'loan', title: 'Loans / Borrowed', hint: 'Money owed to others' },
];

// Sort applies within each type section. The API already returns name order,
// so 'name-asc' (the default) matches the historical view. Amount sorts use
// the balance MAGNITUDE — "high to low" means biggest first whether it's
// money you have (debit) or money you owe (credit/loan).
type AccountSort = 'name-asc' | 'name-desc' | 'amount-desc' | 'amount-asc';
const SORT_KEY = 'spendtracker-accounts-sort';
const SORT_OPTIONS: Array<[AccountSort, string]> = [
  ['name-asc', 'Name (A–Z)'],
  ['name-desc', 'Name (Z–A)'],
  ['amount-desc', 'Amount (high to low)'],
  ['amount-asc', 'Amount (low to high)'],
];

function readSavedSort(): AccountSort {
  const s = localStorage.getItem(SORT_KEY);
  return SORT_OPTIONS.some(([v]) => v === s) ? (s as AccountSort) : 'name-asc';
}

function sortAccounts(list: Account[], sort: AccountSort): Account[] {
  const arr = [...list];
  const byName = (a: Account, b: Account) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const byAmount = (a: Account, b: Account) =>
    Math.abs(a.balanceCents) - Math.abs(b.balanceCents);
  switch (sort) {
    case 'name-asc':
      return arr.sort(byName);
    case 'name-desc':
      return arr.sort((a, b) => byName(b, a));
    case 'amount-desc':
      return arr.sort((a, b) => byAmount(b, a));
    case 'amount-asc':
      return arr.sort(byAmount);
  }
}

export function Accounts({
  accounts,
  onDataChanged,
}: {
  accounts: Account[];
  onDataChanged: () => void;
}) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<AccountSort>(readSavedSort);
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

          <div className="toolbar accounts-sort">
            <label className="sort-label" htmlFor="acct-sort">
              Sort by
            </label>
            <select
              id="acct-sort"
              value={sort}
              onChange={(e) => {
                const s = e.target.value as AccountSort;
                setSort(s);
                localStorage.setItem(SORT_KEY, s);
              }}
            >
              {SORT_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="accounts-grid">
            {SECTIONS.map(({ type, title, hint }) => {
            const items = sortAccounts(accounts.filter((a) => a.type === type), sort);
            if (items.length === 0) return null;
            const subtotal = items.reduce((s, a) => s + a.balanceCents, 0);
            return (
              <div className="panel" key={type}>
                {/* Stacked: title + subtotal share the top line, hint drops below. */}
                <div className="section-title section-title-stacked">
                  <span>
                    {title}
                    <span className="section-hint">{hint}</span>
                  </span>
                  <span className={`num ${subtotal < 0 ? 'amount-expense' : ''}`}>
                    {fmtMoney(subtotal)}
                  </span>
                </div>
                <table className="table">
                  <tbody>
                    {items.map((a) => (
                      <tr
                        key={a.id}
                        className="row-link"
                        onClick={() => navigate(`/accounts/${a.id}`)}
                      >
                        <td>
                          <span className="cat-chip">
                            {a.image ? (
                              <img className="acct-avatar" src={a.image} alt="" />
                            ) : (
                              <span className="color-dot" style={{ background: a.color }} />
                            )}
                            <span>{a.name}</span>
                          </span>
                          {/* Next payment date — only while something is owed. */}
                          {a.dueDay != null && a.balanceCents < 0 && (
                            <div className="due-line">
                              <DueTag dueDay={a.dueDay} dueDay2={a.dueDay2} />
                            </div>
                          )}
                        </td>
                        <td className={`num ${a.balanceCents < 0 ? 'amount-expense' : 'amount-income'}`}>
                          {fmtMoney(a.balanceCents)}
                          {a.balanceCents < 0 && <span className="owed-tag"> owed</span>}
                        </td>
                        <td className="actions">
                          <button
                            className="btn-icon"
                            title="Edit"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAccountModal({ open: true, editing: a });
                            }}
                          >
                            <PencilIcon />
                          </button>
                          <button
                            className="btn-icon danger"
                            title="Delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeAccount(a);
                            }}
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
          /* transfers-cards: ≤860px CSS restacks each row into a list card */
          <table className="table transfers-cards">
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
                  {/* fee-none: the mobile card layout hides the fee line entirely */}
                  <td
                    className={`num ${t.feeCents === 0 ? 'fee-none' : ''}`}
                    style={{ color: t.feeCents > 0 ? 'var(--red)' : 'var(--text-faint)' }}
                  >
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
          accounts={accounts}
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
