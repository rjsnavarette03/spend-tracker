import { FormEvent, useState } from 'react';
import type { Account } from '../../shared/types';
import { api } from '../api';
import { cleanError, fmtMoney, nowTimeHm, parseAmountToCents, todayStr } from '../format';
import { CoinsIcon } from './Icons';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

// "Borrow again" on an existing loan account. With a destination it is a
// transfer (loan -> debit), mirroring the new-loan payout: amount + fee leave
// the loan (owed grows by both) while only the amount lands in the debit
// account. WITHOUT a destination (optional, like the new-loan modal) the debt
// is bumped directly via the loan's opening balance — same mechanism the
// new-loan flow uses for an untracked payout; no ledger row is created.
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
  const [time, setTime] = useState(nowTimeHm());
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const tracked = destId !== '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const amountCents = parseAmountToCents(amount);
    if (amountCents === null) {
      setError('Enter a positive amount, e.g. 500.00');
      return;
    }
    // Optional fee/interest: adds to what you owe; with a destination it is
    // NOT deposited there (transfer math credits only the amount).
    let feeCents = 0;
    if (fee.trim() !== '') {
      const parsedFee = parseAmountToCents(fee);
      if (parsedFee === null) {
        setError('Fee / interest must be a positive amount, or leave it empty');
        return;
      }
      feeCents = parsedFee;
    }
    if (tracked && !date) {
      setError('Pick a date');
      return;
    }
    setSaving(true);
    try {
      if (tracked) {
        await api.transfers.create({
          fromAccountId: account.id,
          toAccountId: Number(destId),
          amountCents,
          feeCents,
          date,
          time: time || null,
          note: note.trim() || `Borrowed from ${account.name}`,
        });
      } else {
        // No destination: fold the borrow into the owed amount, exactly like
        // the new-loan flow's untracked payout. The field is a positive
        // magnitude — the server re-signs it by account type.
        await api.accounts.update(account.id, {
          name: account.name,
          color: account.color,
          image: account.image,
          dueDay: account.dueDay,
          dueDay2: account.dueDay2,
          openingBalanceCents: Math.abs(account.openingBalanceCents) + amountCents + feeCents,
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
    <Modal title={`Borrow again — ${account.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="borrow-dest">Deposit to account (optional)</label>
          <select
            id="borrow-dest"
            value={destId}
            onChange={(e) => setDestId(e.target.value)}
            autoFocus
          >
            <option value="">No account — just track what you owe</option>
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

        {/* Date/time/note live on the transfer row — without a destination no
            row is created, so the fields would be silently discarded. */}
        {tracked && (
          <>
            <div className="form-row">
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
                <label htmlFor="borrow-time">Time (optional)</label>
                <input
                  id="borrow-time"
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </div>
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
          </>
        )}

        <div className="field-hint">
          {tracked
            ? `The amount is deposited into the selected account and added to what you owe on ` +
              `${account.name}. Any fee / interest is added to what you owe too, but never ` +
              `reaches the deposit account.`
            : `Added straight to what you owe on ${account.name} (amount + fee). No deposit is ` +
              `recorded — pick an account above if the money landed in one.`}
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
