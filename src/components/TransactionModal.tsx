import { FormEvent, useMemo, useState } from 'react';
import type { Account, Category, Transaction, TxType } from '../../shared/types';
import { api } from '../api';
import { centsToInput, cleanError, fmtMoney, parseAmountToCents, todayStr } from '../format';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

export function TransactionModal({
  initial,
  categories,
  accounts,
  defaultMonth,
  defaultAccountId,
  lockType,
  onClose,
  onSaved,
}: {
  initial: Transaction | null;
  categories: Category[];
  accounts: Account[];
  defaultMonth: string;
  defaultAccountId?: number;
  // When set, force this transaction type and hide the Expense/Income toggle
  // (e.g. a purchase on a credit card is always an expense).
  lockType?: TxType;
  onClose: () => void;
  onSaved: () => void;
}) {
  const defaultDate = defaultMonth === todayStr().slice(0, 7) ? todayStr() : `${defaultMonth}-01`;

  const [type, setType] = useState<TxType>(initial?.type ?? lockType ?? 'expense');
  const [amount, setAmount] = useState(initial ? centsToInput(initial.amountCents) : '');
  const [date, setDate] = useState(initial?.date ?? defaultDate);
  const [categoryId, setCategoryId] = useState<string>(
    initial?.categoryId != null ? String(initial.categoryId) : ''
  );
  const [accountId, setAccountId] = useState<string>(
    initial?.accountId != null
      ? String(initial.accountId)
      : defaultAccountId != null
        ? String(defaultAccountId)
        : ''
  );
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const options = useMemo(() => categories.filter((c) => c.type === type), [categories, type]);

  // Which accounts a transaction can use:
  //  - expenses: debit or credit (you pay from cash/bank or a card)
  //  - income:   debit only (money is received into cash/bank, not onto a card)
  // Loans are never used here — they're moved via transfers.
  const debitAccounts = useMemo(() => accounts.filter((a) => a.type === 'debit'), [accounts]);
  const creditAccounts = useMemo(
    () => (type === 'expense' ? accounts.filter((a) => a.type === 'credit') : []),
    [accounts, type]
  );
  // Preserve a previously-linked account that's no longer selectable (e.g. a
  // loan, or a credit account on an income tx) so editing doesn't silently drop it.
  const preservedAccount =
    accountId &&
    !debitAccounts.some((a) => String(a.id) === accountId) &&
    !creditAccounts.some((a) => String(a.id) === accountId)
      ? accounts.find((a) => String(a.id) === accountId) ?? null
      : null;
  const showAccountField =
    debitAccounts.length > 0 || creditAccounts.length > 0 || preservedAccount !== null;

  const switchType = (t: TxType) => {
    setType(t);
    // Keep the category only if it exists for the new type.
    if (!categories.some((c) => c.type === t && String(c.id) === categoryId)) {
      setCategoryId('');
    }
    // Clear the account if it's no longer valid: income allows debit only,
    // expense allows debit or credit.
    const acc = accounts.find((a) => String(a.id) === accountId);
    const validNow = acc && (t === 'income' ? acc.type === 'debit' : acc.type !== 'loan');
    if (accountId && !validNow) setAccountId('');
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
        accountId: accountId ? Number(accountId) : null,
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
        {!lockType && (
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
        )}

        <div className="form-row">
          <div className="field">
            <label htmlFor="tx-amount">Amount</label>
            <MoneyInput id="tx-amount" value={amount} onChange={setAmount} autoFocus />
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

        {showAccountField && (
          <div className="field">
            <label htmlFor="tx-account">
              {type === 'expense' ? 'Pay from account' : 'Deposit to account'} (optional)
            </label>
            <select id="tx-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">No account</option>
              {debitAccounts.length > 0 && (
                <optgroup label="Debit">
                  {debitAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({fmtMoney(a.balanceCents)})
                    </option>
                  ))}
                </optgroup>
              )}
              {creditAccounts.length > 0 && (
                <optgroup label="Credit">
                  {creditAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({fmtMoney(a.balanceCents)})
                    </option>
                  ))}
                </optgroup>
              )}
              {preservedAccount && (
                <optgroup label="Other">
                  <option value={preservedAccount.id}>
                    {preservedAccount.name} ({fmtMoney(preservedAccount.balanceCents)})
                  </option>
                </optgroup>
              )}
            </select>
          </div>
        )}

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
