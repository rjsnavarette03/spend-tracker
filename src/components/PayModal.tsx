import { FormEvent, useState } from 'react';
import type { Account } from '../../shared/types';
import { api } from '../api';
import { cleanError, fmtMoney, nowTimeHm, parseAmountToCents, todayStr } from '../format';
import { BanknoteIcon } from './Icons';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

// Pay the given account from another account. Implemented as a transfer
// (source -> account), so the source balance is deducted and this account's
// balance / owed amount updates automatically. Sources are debit or credit
// accounts other than the one being paid.
export function PayModal({
  account,
  accounts,
  onClose,
  onSaved,
}: {
  account: Account;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const sources = accounts.filter(
    (a) => a.id !== account.id && (a.type === 'debit' || a.type === 'credit')
  );

  const [sourceId, setSourceId] = useState<string>(sources[0] ? String(sources[0].id) : '');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [date, setDate] = useState(todayStr());
  const [time, setTime] = useState(nowTimeHm());
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!sourceId) {
      setError('Choose an account to pay from');
      return;
    }
    const amountCents = parseAmountToCents(amount);
    if (amountCents === null) {
      setError('Enter a positive amount, e.g. 500.00');
      return;
    }
    // Optional fee: also leaves the source, but is NOT applied to the account
    // being paid (transfer math credits only the amount to the target).
    let feeCents = 0;
    if (fee.trim() !== '') {
      const parsedFee = parseAmountToCents(fee);
      if (parsedFee === null) {
        setError('Fee must be a positive amount, or leave it empty');
        return;
      }
      feeCents = parsedFee;
    }
    if (!date) {
      setError('Pick a date');
      return;
    }
    setSaving(true);
    try {
      await api.transfers.create({
        fromAccountId: Number(sourceId),
        toAccountId: account.id,
        amountCents,
        feeCents,
        date,
        time: time || null,
        note: note.trim() || `Payment to ${account.name}`,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={`Pay ${account.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="pay-source">Pay from</label>
          <select
            id="pay-source"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            autoFocus
          >
            <option value="">Choose account…</option>
            {sources.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({fmtMoney(a.balanceCents)})
              </option>
            ))}
          </select>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="pay-amount">Amount</label>
            <MoneyInput id="pay-amount" value={amount} onChange={setAmount} />
          </div>
          <div className="field">
            <label htmlFor="pay-fee">Fee (optional)</label>
            <MoneyInput id="pay-fee" value={fee} onChange={setFee} />
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="pay-date">Date</label>
            <input id="pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pay-time">Time (optional)</label>
            <input id="pay-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="pay-note">Note (optional)</label>
          <input
            id="pay-note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder={`Payment to ${account.name}`}
          />
        </div>

        <div className="field-hint">
          The amount plus any fee is deducted from the source account; only the amount is applied
          to {account.name} — the fee doesn't reduce what you owe.
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <BanknoteIcon /> {saving ? 'Paying…' : 'Pay'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
