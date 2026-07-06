import { FormEvent, useMemo, useState } from 'react';
import type { Category, Transaction, TxType } from '../../shared/types';
import { api } from '../api';
import { centsToInput, cleanError, parseAmountToCents, todayStr } from '../format';
import { Modal } from './Modal';

export function TransactionModal({
  initial,
  categories,
  defaultMonth,
  onClose,
  onSaved,
}: {
  initial: Transaction | null;
  categories: Category[];
  defaultMonth: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const defaultDate = defaultMonth === todayStr().slice(0, 7) ? todayStr() : `${defaultMonth}-01`;

  const [type, setType] = useState<TxType>(initial?.type ?? 'expense');
  const [amount, setAmount] = useState(initial ? centsToInput(initial.amountCents) : '');
  const [date, setDate] = useState(initial?.date ?? defaultDate);
  const [categoryId, setCategoryId] = useState<string>(
    initial?.categoryId != null ? String(initial.categoryId) : ''
  );
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const options = useMemo(() => categories.filter((c) => c.type === type), [categories, type]);

  const switchType = (t: TxType) => {
    setType(t);
    // Keep the selection only if it exists for the new type.
    if (!categories.some((c) => c.type === t && String(c.id) === categoryId)) {
      setCategoryId('');
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amountCents = parseAmountToCents(amount);
    if (amountCents === null) {
      setError('Enter a positive amount, e.g. 42.50');
      return;
    }
    if (!date) {
      setError('Pick a date');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const data = {
        amountCents,
        type,
        categoryId: categoryId ? Number(categoryId) : null,
        date,
        note: note.trim(),
      };
      if (initial) await api.transactions.update(initial.id, data);
      else await api.transactions.create(data);
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit transaction' : 'Add transaction'} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="segmented" role="tablist">
          <button
            type="button"
            className={type === 'expense' ? 'active-expense' : ''}
            onClick={() => switchType('expense')}
          >
            Expense
          </button>
          <button
            type="button"
            className={type === 'income' ? 'active-income' : ''}
            onClick={() => switchType('income')}
          >
            Income
          </button>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="tx-amount">Amount</label>
            <input
              id="tx-amount"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="tx-date">Date</label>
            <input id="tx-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="tx-category">Category</label>
          <select id="tx-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorized</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="tx-note">Note (optional)</label>
          <input
            id="tx-note"
            type="text"
            placeholder="e.g. Weekly groceries at Aldi"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
          />
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {initial ? 'Save changes' : 'Add transaction'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
