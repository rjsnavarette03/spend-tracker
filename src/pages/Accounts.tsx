import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Account, AccountType, Transfer } from '../../shared/types';
import { api } from '../api';
import { confirm, toast } from '../components/feedback';
import { AccountEditModal } from '../components/AccountEditModal';
import { DueTag } from '../components/DueTag';
import { PencilIcon, PlusIcon, TransferIcon, TrashIcon } from '../components/Icons';
import { Pager } from '../components/Pager';
import { TransferModal } from '../components/TransferModal';
import { cleanError, dateLabel, fmtMoney, nextDueInfo, timeLabel } from '../format';
import { usePagedTable } from '../usePagedTable';
import type { SortOption } from '../usePagedTable';

// Transfers list: search matches the note and both account names; sort choices
// bake in direction (same pattern as the per-section account sort above).
const TRANSFER_SEARCH = (t: Transfer) => `${t.note} ${t.fromName ?? ''} ${t.toName ?? ''}`;

const TRANSFER_SORTS: SortOption<Transfer>[] = [
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

const SECTIONS: Array<{ type: AccountType; title: string; hint: string }> = [
  { type: 'debit', title: 'Debit', hint: 'Cash, banks & e-wallets' },
  { type: 'credit', title: 'Credit', hint: 'Credit cards' },
  { type: 'loan', title: 'Loans / Borrowed', hint: 'Money owed to others' },
];

// Each type section carries its own sort, chosen from a select inside the
// card. 'name-asc' (the default) matches the historical API name order.
// Amount sorts use the balance MAGNITUDE — "high to low" means biggest first
// whether it's money you have (debit) or money you owe (credit/loan).
// 'due-asc' (credit/loan only — debit accounts can't have due days) puts the
// account whose payment lands soonest first; accounts with no upcoming
// payment (no due day, or nothing owed — same rule as the due pill) go last.
type AccountSort = 'name-asc' | 'name-desc' | 'amount-desc' | 'amount-asc' | 'due-asc';
type SortByType = Record<AccountType, AccountSort>;
const SORT_KEY = 'spendtracker-accounts-sort-v2'; // JSON { debit, credit, loan }
const LEGACY_SORT_KEY = 'spendtracker-accounts-sort'; // v1: one page-wide value
const SORT_OPTIONS: Array<[AccountSort, string]> = [
  ['name-asc', 'Name (A–Z)'],
  ['name-desc', 'Name (Z–A)'],
  ['amount-desc', 'Amount (high to low)'],
  ['amount-asc', 'Amount (low to high)'],
  ['due-asc', 'Due date (soonest)'],
];

function isSort(v: unknown): v is AccountSort {
  return SORT_OPTIONS.some(([s]) => s === v);
}

function readSavedSorts(): SortByType {
  // Runs as a useState initializer (render phase), so localStorage itself may
  // throw here (storage-blocked browsers) — everything stays inside the try.
  const out: SortByType = { debit: 'name-asc', credit: 'name-asc', loan: 'name-asc' };
  try {
    // The old single value (pre per-card sorts) seeds all three sections.
    const legacy = localStorage.getItem(LEGACY_SORT_KEY);
    if (isSort(legacy) && legacy !== 'due-asc') {
      out.debit = out.credit = out.loan = legacy;
    }
    const parsed: unknown = JSON.parse(localStorage.getItem(SORT_KEY) ?? '');
    for (const type of ['debit', 'credit', 'loan'] as const) {
      const v = (parsed as Record<string, unknown>)?.[type];
      if (isSort(v) && !(type === 'debit' && v === 'due-asc')) out[type] = v;
    }
  } catch {
    /* storage unavailable or nothing saved yet — defaults stand */
  }
  return out;
}

function sortAccounts(list: Account[], sort: AccountSort): Account[] {
  const arr = [...list];
  const byName = (a: Account, b: Account) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const byAmount = (a: Account, b: Account) =>
    Math.abs(a.balanceCents) - Math.abs(b.balanceCents);
  // Days until the next payment; no upcoming payment sorts last (Infinity).
  const dueDays = (a: Account) =>
    a.dueDay != null && a.balanceCents < 0 ? nextDueInfo(a.dueDay, a.dueDay2).days : Infinity;
  switch (sort) {
    case 'name-asc':
      return arr.sort(byName);
    case 'name-desc':
      return arr.sort((a, b) => byName(b, a));
    case 'amount-desc':
      return arr.sort((a, b) => byAmount(b, a));
    case 'amount-asc':
      return arr.sort(byAmount);
    case 'due-asc':
      return arr.sort((a, b) => dueDays(a) - dueDays(b) || byName(a, b));
  }
}

export function Accounts({
  accounts,
  loaded,
  onDataChanged,
}: {
  accounts: Account[];
  loaded: boolean;
  onDataChanged: () => void;
}) {
  const navigate = useNavigate();
  const [sorts, setSorts] = useState<SortByType>(readSavedSorts);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [accountModal, setAccountModal] = useState<{ open: boolean; editing: Account | null }>({
    open: false,
    editing: null,
  });
  const [transferModal, setTransferModal] = useState<{ open: boolean; editing: Transfer | null }>({
    open: false,
    editing: null,
  });
  const pagedTransfers = usePagedTable(transfers, TRANSFER_SEARCH, TRANSFER_SORTS, {
    initialSort: 'date-desc',
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

      {!loaded ? (
        <div className="empty-state">Loading…</div>
      ) : accounts.length === 0 ? (
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
            const items = sortAccounts(accounts.filter((a) => a.type === type), sorts[type]);
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
                {/* Per-card sort; hidden when there's nothing to reorder. */}
                {items.length > 1 && (
                  <div className="card-sort">
                    <label className="sort-label" htmlFor={`acct-sort-${type}`}>
                      Sort
                    </label>
                    <select
                      id={`acct-sort-${type}`}
                      // The visible label is just "Sort"; name the section so
                      // screen-reader lists can tell the three cards apart.
                      aria-label={`Sort ${title} accounts`}
                      value={sorts[type]}
                      onChange={(e) => {
                        const next = { ...sorts, [type]: e.target.value as AccountSort };
                        setSorts(next);
                        try {
                          localStorage.setItem(SORT_KEY, JSON.stringify(next));
                        } catch {
                          /* storage unavailable — sort still applies this visit */
                        }
                      }}
                    >
                      {SORT_OPTIONS.filter(([v]) => type !== 'debit' || v !== 'due-asc').map(
                        ([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        )
                      )}
                    </select>
                  </div>
                )}
                <table className="table">
                  <tbody>
                    {items.map((a) => (
                      <tr
                        key={a.id}
                        className="row-link"
                        role="button"
                        tabIndex={0}
                        aria-label={`View ${a.name}`}
                        onClick={() => navigate(`/accounts/${a.id}`)}
                        onKeyDown={(e) => {
                          // The whole row opens the account (where it can be
                          // edited or deleted); Enter/Space mirror the click.
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            navigate(`/accounts/${a.id}`);
                          }
                        }}
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

      <div className="panel mt-panel">
        <div className="panel-head">
          <div className="panel-title">Transfers</div>
          {transfers.length > 0 && (
            <div className="table-controls">
              <select
                aria-label="Sort transfers"
                value={pagedTransfers.sort}
                onChange={(e) => pagedTransfers.setSort(e.target.value)}
              >
                {TRANSFER_SORTS.map((o) => (
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
        {transfers.length === 0 ? (
          <div className="empty-state">
            No transfers yet. Move money between accounts — with an optional fee — and both
            balances update automatically.
          </div>
        ) : pagedTransfers.matchedCount === 0 ? (
          <div className="empty-state">No transfers match your search.</div>
        ) : (
          /* transfers-cards: ≤860px CSS restacks each row into a list card */
          <>
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
              {pagedTransfers.visible.map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {dateLabel(t.date)}
                    {t.time && <span className="time-dim"> · {timeLabel(t.time)}</span>}
                  </td>
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
