import { FormEvent, useState } from 'react';
import type { Account } from '../../shared/types';
import { api } from '../api';
import { cleanError, fmtMoney, parseAmountToCents, todayStr } from '../format';
import { CoinsIcon } from './Icons';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

// "Borrow again" on an existing loan account. Implemented as a transfer
// (loan -> destination debit account), which mirrors the new-loan payout in
// AccountEditModal: the amount plus any fee/interest leaves the loan (so what
// you owe grows by amount + fee), while only the amount lands in the chosen
// debit account. Destinations are debit accounts only.
export function BorrowModal({
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
  const destinations = accounts.filter((a) => a.type === 'debit');

  const [destId, setDestId] = useState<string>(destinations[0] ? String(destinations[0].id) : '');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!destId) {
      setError('Choose an account to deposit into');
      return;
    }
    const amountCents = parseAmountToCents(amount);
    if (amountCents === null) {
      setError('Enter a positive amount, e.g. 500.00');
      return;
    }
    // Optional fee/interest: also leaves the loan (adds to what you owe) but is
    // NOT deposited into the destination — transfer math credits only the
    // amount to the target.
    let feeCents = 0;
    if (fee.trim() !== '') {
      const parsedFee = parseAmountToCents(fee);
      if (parsedFee === null) {
        setError('Fee / interest must be a positive amount, or leave it empty');
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
        fromAccountId: account.id,
        toAccountId: Number(destId),
        amountCents,
        feeCents,
        date,
        note: note.trim() || `Borrowed from ${account.name}`,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={`Borrow again — ${account.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="borrow-dest">Deposit to</label>
          <select
            id="borrow-dest"
            value={destId}
            onChange={(e) => setDestId(e.target.value)}
            autoFocus
          >
            <option value="">Choose account…</option>
            {destinations.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({fmtMoney(a.balanceCents)})
              </option>
            ))}
          </select>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="borrow-amount">Amount</label>
            <MoneyInput id="borrow-amount" value={amount} onChange={setAmount} />
          </div>
          <div className="field">
            <label htmlFor="borrow-fee">Fee / interest (optional)</label>
            <MoneyInput id="borrow-fee" value={fee} onChange={setFee} placeholder="0.00" />
          </div>
        </div>

        <div className="field">
          <label htmlFor="borrow-date">Date</label>
          <input
            id="borrow-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="borrow-note">Note (optional)</label>
          <input
            id="borrow-note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder={`Borrowed from ${account.name}`}
          />
        </div>

        <div className="field-hint">
          The amount is deposited into the selected account and added to what you owe on{' '}
          {account.name}. Any fee / interest is added to what you owe too, but never reaches the
          deposit account.
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <CoinsIcon size={16} /> {saving ? 'Borrowing…' : 'Borrow'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
