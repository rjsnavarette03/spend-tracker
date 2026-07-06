import { FormEvent, useState } from 'react';
import type { Account, AccountType } from '../../shared/types';
import { api } from '../api';
import { centsToInput, cleanError, parseSignedAmountToCents } from '../format';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

const SWATCHES = [
  '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#f472b6', '#fb7185', '#f87171',
  '#f97316', '#f59e0b', '#eab308', '#84cc16', '#34d399', '#2dd4bf', '#94a3b8', '#e8eaf0',
];

const TYPE_LABELS: Record<AccountType, string> = {
  debit: 'Debit',
  credit: 'Credit',
  loan: 'Loan / Borrowed',
};

export function AccountEditModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: Account | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<AccountType>(initial?.type ?? 'debit');
  const [color, setColor] = useState(initial?.color ?? SWATCHES[0]);
  // Field holds a positive magnitude; the backend signs it by account type.
  const [opening, setOpening] = useState(
    initial ? centsToInput(Math.abs(initial.openingBalanceCents)) : ''
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) {
      setError('Enter a name');
      return;
    }
    const openingCents = parseSignedAmountToCents(opening);
    if (openingCents === null) {
      setError('Enter a valid amount, e.g. 1500');
      return;
    }
    setSaving(true);
    try {
      if (initial) {
        await api.accounts.update(initial.id, {
          name: name.trim(),
          color,
          openingBalanceCents: openingCents,
        });
      } else {
        await api.accounts.create({
          name: name.trim(),
          type,
          color,
          openingBalanceCents: openingCents,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit account' : 'New account'} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="acc-name">Name</label>
          <input
            id="acc-name"
            type="text"
            value={name}
            placeholder="e.g. BPI Savings, Visa card, Loan from Mom"
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoFocus
          />
        </div>

        <div className="field">
          <label>Type{initial ? ' (fixed after creation)' : ''}</label>
          <div className="segmented">
            {(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => (
              <button
                key={t}
                type="button"
                className={type === t ? 'active-account' : ''}
                disabled={initial !== null}
                onClick={() => setType(t)}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="acc-opening">Amount</label>
          <MoneyInput id="acc-opening" value={opening} onChange={setOpening} />
          <div className="field-hint">
            {type === 'debit'
              ? "The account's current balance."
              : type === 'credit'
                ? 'How much you currently owe on this card — recorded as a negative balance automatically.'
                : 'How much you currently owe / borrowed — recorded as a negative balance automatically.'}
          </div>
        </div>

        <div className="field">
          <label>Color</label>
          <div className="swatches">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch ${c === color ? 'selected' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title={c}
              />
            ))}
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {initial ? 'Save changes' : 'Create account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
