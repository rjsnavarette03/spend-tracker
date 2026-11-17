import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { Account, Category, SplitInput, Transaction, TxType } from '../../shared/types';
import { isArchived } from '../accounts';
import { api } from '../api';
import { centsToInput, cleanError, fmtMoney, parseAmountToCents } from '../format';
import { CheckIcon, PlusIcon, TrashIcon } from './Icons';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

// One receipt divided across categories (POST /transactions/split, or
// PUT /transactions/:id/split to change one). Each part is saved as an
// ordinary transaction in its own category, sharing the type, account, date,
// time and note, so budgets and reports count it in the right place.
// Opened from TransactionModal: its "Split across categories" link, or
// directly when the transaction being edited is already part of a split.

/** The transaction form's state, handed over when the split form opens. */
export interface SplitDraft {
  type: TxType;
  amountCents: number | null; // what the parts should add up to, when known
  categoryId: string; // '' = uncategorized
  accountId: string; // '' = no account
  date: string;
  time: string;
  note: string;
}

interface PartRow {
  key: number;
  id: number | null; // an existing transaction this part keeps
  categoryId: string;
  amount: string;
}

const MAX_PARTS = 20;
let nextKey = 1;
const partRow = (id: number | null, categoryId: string, amount: string): PartRow => ({ key: nextKey++, id, categoryId, amount });

export function SplitModal({
  initial,
  draft,
  categories,
  accounts,
  lockType,
  onClose,
  onSaved,
}: {
  // A part of the split being edited, an ordinary transaction being split, or
  // null for a new split.
  initial: Transaction | null;
  draft: SplitDraft;
  categories: Category[];
  accounts: Account[];
  lockType?: TxType;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isSplit = initial?.splitGroup != null;
  const [type, setType] = useState<TxType>(draft.type);
  const [accountId, setAccountId] = useState(draft.accountId);
  const [date, setDate] = useState(draft.date);
  const [time, setTime] = useState(draft.time);
  const [note, setNote] = useState(draft.note);
  // Splitting one transaction: it becomes the first part (keeping its id) and
  // starts with the whole amount, to be divided.
  const [parts, setParts] = useState<PartRow[]>(() =>
    isSplit
      ? []
      : [
          partRow(initial?.id ?? null, draft.categoryId, draft.amountCents ? centsToInput(draft.amountCents) : ''),
          partRow(null, '', ''),
        ]
  );
  const [target, setTarget] = useState<number | null>(isSplit ? null : draft.amountCents);
  const [loading, setLoading] = useState(isSplit);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // An existing split: load every part of the receipt.
  useEffect(() => {
    if (!initial || initial.splitGroup == null) return;
    let stale = false;
    api.transactions
      .list({ splitGroup: initial.splitGroup })
      .then((rows) => {
        if (stale) return;
        const sorted = [...rows].sort((a, b) => a.id - b.id);
        setParts(sorted.map((t) => partRow(t.id, t.categoryId != null ? String(t.categoryId) : '', centsToInput(t.amountCents))));
        setTarget(sorted.reduce((s, t) => s + t.amountCents, 0));
        setLoading(false);
      })
      .catch((err) => {
        if (stale) return;
        setError(cleanError(err));
        setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [initial]);

  const options = useMemo(() => categories.filter((c) => c.type === type), [categories, type]);
  // Same choices as a single transaction: debit accounts, credit cards for
  // expenses only, never loans; an account the receipt already uses stays.
  const choices = accounts.filter(
    (a) => !isArchived(a) && (a.type === 'debit' || (a.type === 'credit' && type === 'expense'))
  );
  const kept = accountId && !choices.some((a) => String(a.id) === accountId) ? accounts.find((a) => String(a.id) === accountId) : undefined;

  const switchType = (t: TxType) => {
    setType(t);
    setParts((list) =>
      list.map((p) => (categories.some((c) => c.type === t && String(c.id) === p.categoryId) ? p : { ...p, categoryId: '' }))
    );
    const acc = accounts.find((a) => String(a.id) === accountId);
    if (acc && (t === 'income' ? acc.type !== 'debit' : acc.type === 'loan')) setAccountId('');
  };

  const update = (i: number, patch: Partial<PartRow>) => setParts((list) => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const total = parts.reduce((s, p) => s + (p.amount.trim() === '' ? 0 : parseAmountToCents(p.amount) ?? 0), 0);
  const left = target !== null && target > 0 ? target - total : null;

  // Puts what's left into the first empty part, or a new one.
  const fillRest = () => {
    if (left === null || left <= 0) return;
    const empty = parts.findIndex((p) => p.amount.trim() === '');
    if (empty >= 0) update(empty, { amount: centsToInput(left) });
    else if (parts.length < MAX_PARTS) setParts([...parts, partRow(null, '', centsToInput(left))]);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    // A blank extra row is ignored rather than refused.
    const filled = parts.filter((p) => p.amount.trim() !== '' || p.categoryId !== '' || p.id !== null);
    if (filled.length < (initial ? 1 : 2)) {
      setError(initial ? 'Keep at least one part' : 'A split needs at least two parts');
      return;
    }
    const out: SplitInput['parts'] = [];
    for (const p of filled) {
      const cents = parseAmountToCents(p.amount);
      if (cents === null) {
        setError('Enter an amount for each part, or remove it');
        return;
      }
      out.push({ id: p.id, categoryId: p.categoryId ? Number(p.categoryId) : null, amountCents: cents });
    }
    if (!date) {
      setError('Pick a date');
      return;
    }
    const data: SplitInput = {
      type,
      accountId: accountId ? Number(accountId) : null,
      date,
      time: time || null,
      note: note.trim(),
      parts: out,
    };
    setSaving(true);
    try {
      if (initial) await api.transactions.resplit(initial.id, data);
      else await api.transactions.split(data);
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  const removeAll = async () => {
    if (!initial) return;
    setSaving(true);
    try {
      await api.transactions.removeSplit(initial.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={isSplit ? 'Edit split' : 'Split across categories'} onClose={onClose}>
      {loading ? (
        <div className="field-hint">Loading the parts…</div>
      ) : (
        <form className="form-grid" onSubmit={submit}>
          {!lockType && (
            <div className="segmented" role="group" aria-label="Transaction type">
              <button type="button" className={type === 'expense' ? 'active-expense' : ''} onClick={() => switchType('expense')}>
                Expense
              </button>
              <button type="button" className={type === 'income' ? 'active-income' : ''} onClick={() => switchType('income')}>
                Income
              </button>
            </div>
          )}

          <div className="field">
            <label>Parts</label>
            <div className="split-parts">
              {parts.map((p, i) => (
                <div className="split-part" key={p.key}>
                  <select
                    aria-label={`Category for part ${i + 1}`}
                    value={p.categoryId}
                    onChange={(e) => update(i, { categoryId: e.target.value })}
                  >
                    <option value="">Uncategorized</option>
                    {options.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <MoneyInput
                    ariaLabel={`Amount for part ${i + 1}`}
                    value={p.amount}
                    onChange={(v) => update(i, { amount: v })}
                    autoFocus={i === 1 && !isSplit}
                  />
                  <button
                    type="button"
                    className="btn-icon danger"
                    title="Remove this part"
                    aria-label={`Remove part ${i + 1}`}
                    onClick={() => setParts(parts.filter((_, j) => j !== i))}
                    disabled={parts.length <= 1}
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </div>
            <div className="split-foot">
              <button
                type="button"
                className="btn"
                onClick={() => setParts([...parts, partRow(null, '', '')])}
                disabled={parts.length >= MAX_PARTS}
              >
                <PlusIcon /> Add part
              </button>
              <span className="split-total" role="status">
                Total <strong className="num">{fmtMoney(total)}</strong>
                {left !== null && left !== 0 && (
                  <span className={left < 0 ? 'amount-expense' : 'sub-next-muted'}>
                    {' · '}
                    {left > 0 ? `${fmtMoney(left)} left to assign` : `${fmtMoney(-left)} more than ${fmtMoney(target ?? 0)}`}
                  </span>
                )}
                {left !== null && left > 0 && (
                  <>
                    {' '}
                    <button type="button" className="link-button" onClick={fillRest}>
                      Fill the rest
                    </button>
                  </>
                )}
              </span>
            </div>
          </div>

          <div className="form-row">
            <div className="field">
              <label htmlFor="split-date">Date</label>
              <input id="split-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="split-time">Time (optional)</label>
              <input id="split-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>

          <div className="field">
            <label htmlFor="split-account">{type === 'expense' ? 'Pay from account' : 'Deposit to account'} (optional)</label>
            <select id="split-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">No account</option>
              {[...choices, ...(kept ? [kept] : [])].map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({fmtMoney(a.balanceCents)})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="split-note">Note (optional)</label>
            <input
              id="split-note"
              type="text"
              placeholder="e.g. Supermarket receipt"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
            />
          </div>

          <div className="field-hint">
            Each part is saved as its own {type} in its category, with the same date, account and note, so budgets
            and reports count it in the right place.
            {initial && ' Keeping just one part turns it back into a single transaction.'}
          </div>

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}

          <div className="form-actions">
            {isSplit &&
              (confirmDelete ? (
                <span className="split-delete">
                  <button type="button" className="btn btn-danger" onClick={() => void removeAll()} disabled={saving}>
                    <TrashIcon /> Delete all {parts.length} parts
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button type="button" className="btn btn-danger split-delete" onClick={() => setConfirmDelete(true)}>
                  <TrashIcon /> Delete split
                </button>
              ))}
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <CheckIcon /> {isSplit ? 'Save changes' : 'Save split'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
