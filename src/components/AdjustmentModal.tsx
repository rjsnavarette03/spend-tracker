import { FormEvent, useState } from 'react';
import type { Account, Adjustment, AdjustmentReason } from '../../shared/types';
import { api } from '../api';
import { centsToInput, cleanError, fmtMoney, nowTimeHm, parseAmountToCents, todayStr } from '../format';
import { SlidersIcon } from './Icons';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

type Effect = 'lower' | 'raise'; // what the adjustment does to what's owed

const REASONS: {
  value: AdjustmentReason;
  label: string;
  // Picking the reason sets the direction when it only ever goes one way.
  effect: Effect | null;
  hint: string;
}[] = [
  {
    value: 'points',
    label: 'Points or rewards used',
    effect: 'lower',
    hint: 'You paid part of the bill with points, so you owe less. The purchase itself still counts as spending.',
  },
  {
    value: 'refund',
    label: 'Refund difference',
    effect: null,
    hint:
      'A refund came back a little different from the charge, as often happens with foreign currency. ' +
      'Delete or edit the refunded purchase, then enter just the difference here: if less came back than ' +
      'was charged, it adds to what you owe.',
  },
  {
    value: 'fee',
    label: 'Installment conversion fee',
    effect: 'raise',
    hint: 'The fee the bank charged to turn a purchase into installments.',
  },
  {
    value: 'other',
    label: 'Other correction',
    effect: null,
    hint: "Anything else that makes this card's balance match the bank's.",
  },
];

/** Short name for the ledger, e.g. "Points used". */
export function adjustmentReasonLabel(reason: AdjustmentReason): string {
  switch (reason) {
    case 'points':
      return 'Points used';
    case 'refund':
      return 'Refund difference';
    case 'fee':
      return 'Installment fee';
    default:
      return 'Correction';
  }
}

function owedLine(balanceCents: number): string {
  if (balanceCents < 0) return `you'll owe ${fmtMoney(-balanceCents)}`;
  if (balanceCents > 0) return `the card will have ${fmtMoney(balanceCents)} in credit`;
  return "it'll be fully paid off";
}

// A change to a credit card's balance that isn't a purchase or a payment.
// It moves the balance (and net worth) only, never income, spending or budgets.
export function AdjustmentModal({
  account,
  initial,
  onClose,
  onSaved,
}: {
  account: Account;
  initial: Adjustment | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState<AdjustmentReason>(initial?.reason ?? 'points');
  const [effect, setEffect] = useState<Effect>(
    initial ? (initial.amountCents > 0 ? 'lower' : 'raise') : 'lower'
  );
  const [amount, setAmount] = useState(initial ? centsToInput(Math.abs(initial.amountCents)) : '');
  const [date, setDate] = useState(initial?.date ?? todayStr());
  const [time, setTime] = useState(initial ? initial.time ?? '' : nowTimeHm());
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const info = REASONS.find((r) => r.value === reason) ?? REASONS[0];

  const pickReason = (value: AdjustmentReason) => {
    setReason(value);
    const preset = REASONS.find((r) => r.value === value)?.effect;
    if (preset) setEffect(preset);
  };

  // The balance this would leave, counted without the entry being edited.
  const parsed = parseAmountToCents(amount);
  const signed = parsed === null ? null : effect === 'lower' ? parsed : -parsed;
  const after =
    signed === null ? null : account.balanceCents - (initial?.amountCents ?? 0) + signed;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (signed === null) {
      setError('Enter a positive amount, e.g. 50.00');
      return;
    }
    if (!date) {
      setError('Pick a date');
      return;
    }
    setSaving(true);
    try {
      const data = {
        accountId: account.id,
        amountCents: signed,
        reason,
        date,
        time: time || null,
        note: note.trim(),
      };
      if (initial) await api.adjustments.update(initial.id, data);
      else await api.adjustments.create(data);
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={`${initial ? 'Edit adjustment' : 'Adjust balance'} — ${account.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="adj-reason">Reason</label>
          <select
            id="adj-reason"
            value={reason}
            onChange={(e) => pickReason(e.target.value as AdjustmentReason)}
            autoFocus
          >
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <div className="field-hint">{info.hint}</div>
        </div>

        <div className="segmented" role="group" aria-label="What the adjustment does">
          <button
            type="button"
            className={effect === 'lower' ? 'active-income' : ''}
            aria-pressed={effect === 'lower'}
            onClick={() => setEffect('lower')}
          >
            Lowers what I owe
          </button>
          <button
            type="button"
            className={effect === 'raise' ? 'active-expense' : ''}
            aria-pressed={effect === 'raise'}
            onClick={() => setEffect('raise')}
          >
            Adds to what I owe
          </button>
        </div>

        <div className="field">
          <label htmlFor="adj-amount">Amount</label>
          <MoneyInput id="adj-amount" value={amount} onChange={setAmount} />
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="adj-date">Date</label>
            <input id="adj-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="adj-time">Time (optional)</label>
            <input id="adj-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="adj-note">Note (optional)</label>
          <input
            id="adj-note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder={reason === 'fee' ? 'e.g. Laptop, 12 months' : ''}
          />
        </div>

        <div className="field-hint">
          {after !== null && <>After this, {owedLine(after)}. </>}
          Adjustments change this card's balance only: they don't count as income or spending, so
          your reports and budgets stay the same.
          {reason === 'fee' && ' To count the fee as spending, add it as an expense instead.'}
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <SlidersIcon size={16} /> {saving ? 'Saving…' : initial ? 'Save' : 'Adjust'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
