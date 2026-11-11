import { FormEvent, useMemo, useState } from 'react';
import type { Account } from '../../shared/types';
import { isArchived } from '../accounts';
import { api } from '../api';
import { centsToInput, cleanError, fmtMoney, parseAmountToCents, todayStr } from '../format';
import { shortDateLabel } from '../schedule';
import type { PaydayOccurrence } from '../schedule';
import { toast } from './feedback';
import { BanknoteIcon } from './Icons';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

// "Log received" for one payday: records the salary actually received as an
// income transaction (POST /schedule/pay) linked to that payday.
export function LogReceivedModal({
  occurrence,
  accounts,
  onClose,
  onSaved,
}: {
  occurrence: PaydayOccurrence;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const item = occurrence.item;
  const today = todayStr();
  const debitAccounts = useMemo(() => accounts.filter((a) => a.type === 'debit' && !isArchived(a)), [accounts]);
  const [amount, setAmount] = useState(centsToInput(item.amountCents));
  const [accountId, setAccountId] = useState<string>(
    item.accountId != null
      ? String(item.accountId)
      : debitAccounts.length === 1
        ? String(debitAccounts[0].id)
        : ''
  );
  // Default to the expected date, unless logging ahead of it.
  const [date, setDate] = useState(occurrence.date <= today ? occurrence.date : today);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amountCents = parseAmountToCents(amount);
    if (amountCents === null) {
      setError('Enter the amount you received, e.g. 53,500.00');
      return;
    }
    if (!accountId) {
      setError('Pick the account the salary landed in');
      return;
    }
    if (!date) {
      setError('Pick the date it arrived');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.schedule.pay({
        itemId: item.id,
        dueDate: occurrence.dueDate,
        accountId: Number(accountId),
        amountCents,
        feeCents: 0,
        date,
        time: null,
        note: note.trim(),
      });
      toast.success(`Logged ${fmtMoney(amountCents)} for ${item.name}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={`Log salary · ${item.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="field-hint">
          Expected {fmtMoney(item.amountCents)} on {shortDateLabel(occurrence.date)}
          {occurrence.shifted && ` (moved from ${shortDateLabel(occurrence.dueDate)})`}.
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="log-amount">Amount received</label>
            <MoneyInput id="log-amount" value={amount} onChange={setAmount} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="log-date">Date received</label>
            <input id="log-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="log-account">Landed in</label>
          <select id="log-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="" disabled>
              Pick an account
            </option>
            {debitAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({fmtMoney(a.balanceCents)})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="log-note">Note (optional)</label>
          <input
            id="log-note"
            type="text"
            value={note}
            maxLength={500}
            placeholder={item.name}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className="field-hint">
          Adds an income transaction to this account, the same as Add transaction. To change or
          undo it later, edit or delete it on the Transactions page.
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <BanknoteIcon /> {saving ? 'Logging…' : 'Log received'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
