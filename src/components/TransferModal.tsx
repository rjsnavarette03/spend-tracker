import { FormEvent, useState } from 'react';
import type { Account, Transfer } from '../../shared/types';
import { api } from '../api';
import { centsToInput, cleanError, fmtMoney, nowTimeHm, parseAmountToCents, todayStr } from '../format';
import { CheckIcon, TransferIcon } from './Icons';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

export function TransferModal({
  initial,
  accounts,
  defaultFromAccountId,
  onClose,
  onSaved,
}: {
  initial: Transfer | null;
  accounts: Account[];
  // When creating a new transfer, preselect this account as the source
  // (e.g. opened from a debit account's detail page). Ignored when editing.
  defaultFromAccountId?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fromId, setFromId] = useState<string>(
    initial?.fromAccountId != null
      ? String(initial.fromAccountId)
      : defaultFromAccountId != null
        ? String(defaultFromAccountId)
        : ''
  );
  const [toId, setToId] = useState<string>(
    initial?.toAccountId != null ? String(initial.toAccountId) : ''
  );
  const [amount, setAmount] = useState(initial ? centsToInput(initial.amountCents) : '');
  const [fee, setFee] = useState(initial && initial.feeCents > 0 ? centsToInput(initial.feeCents) : '');
  const [date, setDate] = useState(initial?.date ?? todayStr());
  // New transfers default to the current time; edits keep the stored value.
  const [time, setTime] = useState(initial ? initial.time ?? '' : nowTimeHm());
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Transfers move money between spending (debit) accounts only.
  const debitAccounts = accounts.filter((a) => a.type === 'debit');
  // Options for a select: debit accounts, plus the currently-chosen account if
  // it's a legacy non-debit one, so editing an old transfer doesn't drop it.
  const optionsFor = (currentId: string) => {
    const list = [...debitAccounts];
    if (currentId && !list.some((a) => String(a.id) === currentId)) {
      const extra = accounts.find((a) => String(a.id) === currentId);
      if (extra) list.push(extra);
    }
    return list;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!fromId || !toId) {
      setError('Choose both accounts');
      return;
    }
    if (fromId === toId) {
      setError('Choose two different accounts');
      return;
    }
    const amountCents = parseAmountToCents(amount);
    if (amountCents === null) {
      setError('Enter a positive amount, e.g. 500.00');
      return;
    }
    let feeCents = 0;
    if (fee.trim() !== '') {
      const parsed = parseAmountToCents(fee);
      if (parsed === null) {
        setError('Fee must be a positive amount, or leave it empty');
        return;
      }
      feeCents = parsed;
    }
    if (!date) {
      setError('Pick a date');
      return;
    }
    setSaving(true);
    try {
      const data = {
        fromAccountId: Number(fromId),
        toAccountId: Number(toId),
        amountCents,
        feeCents,
        date,
        time: time || null,
        note: note.trim(),
      };
      if (initial) await api.transfers.update(initial.id, data);
      else await api.transfers.create(data);
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit transfer' : 'Transfer between accounts'} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="form-row">
          <div className="field">
            <label htmlFor="tf-from">From</label>
            <select id="tf-from" value={fromId} onChange={(e) => setFromId(e.target.value)} autoFocus>
              <option value="">Choose account…</option>
              {optionsFor(fromId).map((a) => (
                <option key={a.id} value={a.id} disabled={String(a.id) === toId}>
                  {a.name} ({fmtMoney(a.balanceCents)})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="tf-to">To</label>
            <select id="tf-to" value={toId} onChange={(e) => setToId(e.target.value)}>
              <option value="">Choose account…</option>
              {optionsFor(toId).map((a) => (
                <option key={a.id} value={a.id} disabled={String(a.id) === fromId}>
                  {a.name} ({fmtMoney(a.balanceCents)})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="tf-amount">Amount</label>
            <MoneyInput id="tf-amount" value={amount} onChange={setAmount} />
          </div>
          <div className="field">
            <label htmlFor="tf-fee">Fee (optional)</label>
            <MoneyInput id="tf-fee" value={fee} onChange={setFee} />
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="tf-date">Date</label>
            <input id="tf-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="tf-time">Time (optional)</label>
            <input id="tf-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="tf-note">Note (optional)</label>
          <input
            id="tf-note"
            type="text"
            placeholder="e.g. Top-up e-wallet"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
          />
        </div>

        <div className="field-hint">
          The amount plus any fee leaves the “from” account; only the amount arrives in the
          “to” account.
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {initial ? <CheckIcon /> : <TransferIcon />} {initial ? 'Save changes' : 'Transfer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
