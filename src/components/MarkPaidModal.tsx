import { FormEvent, useMemo, useState } from 'react';
import type { Account, Category } from '../../shared/types';
import { isArchived } from '../accounts';
import { api } from '../api';
import { centsToInput, cleanError, fmtMoney, parseAmountToCents, todayStr } from '../format';
import { shortDateLabel } from '../schedule';
import type { DueStatus, ItemOccurrence } from '../schedule';
import { toast } from './feedback';
import { BanknoteIcon } from './Icons';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

// "Mark as paid" for one due date on the Schedule. Records the payment through
// the same server paths as the rest of the app (POST /schedule/pay →
// createTransfer / createTransaction): loans, cards and savings become a
// transfer from the chosen account (like Pay on the account page), bills and
// allowances an expense. Any amount: less than due is partial, more is extra.
export function MarkPaidModal({
  occurrence,
  status,
  accounts,
  categories,
  onClose,
  onSaved,
}: {
  occurrence: ItemOccurrence;
  status: DueStatus | undefined;
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const item = occurrence.item;
  const asTransfer = item.kind === 'loan' || item.kind === 'card' || item.kind === 'savings';
  const target = asTransfer ? accounts.find((a) => a.id === item.accountId) : undefined;
  const category = categories.find((c) => c.id === item.categoryId);
  const sources = useMemo(
    () => accounts.filter((a) => (a.type === 'debit' || a.type === 'credit') && a.id !== target?.id && !isArchived(a)),
    [accounts, target]
  );
  const paidSoFar = status?.paidCents ?? 0;
  // Already settled → this is an extra payment; offer the regular amount again.
  const suggested = status && status.remainingCents > 0 ? status.remainingCents : occurrence.amountCents;

  const [amount, setAmount] = useState(suggested > 0 ? centsToInput(suggested) : '');
  const [fee, setFee] = useState('');
  const [accountId, setAccountId] = useState<string>(() => {
    const preferred = sources.find((a) => a.id === item.payFromAccountId) ?? sources.find((a) => a.type === 'debit');
    return preferred ? String(preferred.id) : '';
  });
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const amountCents = parseAmountToCents(amount);
  const due = status ? status.remainingCents : occurrence.amountCents;
  const source = sources.find((a) => a.id === Number(accountId));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (amountCents === null) {
      setError('Enter a positive amount, e.g. 4,900.00');
      return;
    }
    if (!accountId) {
      setError('Pick the account you paid from');
      return;
    }
    let feeCents = 0;
    if (asTransfer && fee.trim() !== '') {
      const parsed = parseAmountToCents(fee);
      if (parsed === null) {
        setError('The fee must be a positive amount, or leave it empty');
        return;
      }
      feeCents = parsed;
    }
    if (!date) {
      setError('Pick the date you paid');
      return;
    }
    setSaving(true);
    try {
      await api.schedule.pay({
        itemId: item.id,
        dueDate: occurrence.dueDate,
        accountId: Number(accountId),
        amountCents,
        feeCents,
        date,
        time: null,
        note: note.trim(),
      });
      toast.success(`Paid ${fmtMoney(amountCents)} — ${item.name}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  let effect = '';
  if (amountCents !== null && due > 0 && amountCents < due) {
    effect = `Partial payment — ${fmtMoney(due - amountCents)} stays open for this due date.`;
  } else if (amountCents !== null && amountCents > due) {
    const extra = amountCents - due;
    effect =
      item.kind === 'loan' || item.kind === 'card'
        ? `${fmtMoney(extra)} extra — it goes toward the balance, so you owe less sooner.`
        : `${fmtMoney(extra)} more than is due.`;
  }

  return (
    <Modal title={`Pay ${item.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="field-hint">
          {fmtMoney(occurrence.amountCents)} due {shortDateLabel(occurrence.dueDate)}
          {paidSoFar > 0 && ` · ${fmtMoney(paidSoFar)} paid so far`}
          {target && target.balanceCents < 0 && ` · ${target.name} owes ${fmtMoney(-target.balanceCents)}`}
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="paid-amount">Amount</label>
            <MoneyInput id="paid-amount" value={amount} onChange={setAmount} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="paid-date">Date paid</label>
            <input id="paid-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        {effect && <div className="field-hint">{effect}</div>}

        <div className="form-row">
          <div className="field">
            <label htmlFor="paid-from">Paid from</label>
            <select id="paid-from" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="" disabled>
                Pick an account
              </option>
              {sources.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({fmtMoney(a.balanceCents)})
                </option>
              ))}
            </select>
          </div>
          {asTransfer ? (
            <div className="field">
              <label htmlFor="paid-fee">Fee (optional)</label>
              <MoneyInput id="paid-fee" value={fee} onChange={setFee} />
            </div>
          ) : (
            <div className="field" aria-hidden="true" />
          )}
        </div>

        <div className="field">
          <label htmlFor="paid-note">Note (optional)</label>
          <input
            id="paid-note"
            type="text"
            value={note}
            maxLength={500}
            placeholder={item.kind === 'savings' ? `Savings: ${item.name}` : asTransfer ? `Payment to ${item.name}` : item.name}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className="field-hint">
          {asTransfer
            ? `Recorded as a payment from ${source?.name ?? 'the account above'} to ${target?.name ?? item.name} — the same as Pay on the account page${item.kind === 'savings' ? '' : '; the fee (if any) leaves the source but doesn’t reduce what you owe'}.`
            : `Recorded as an expense${category ? ` in ${category.name}` : ''} from ${source?.name ?? 'the account above'}.`}{' '}
          To change or undo it later, edit or delete it on the Transactions page.
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <BanknoteIcon /> {saving ? 'Paying…' : amountCents !== null ? `Pay ${fmtMoney(amountCents)}` : 'Pay'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
