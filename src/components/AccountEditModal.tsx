import { ChangeEvent, FormEvent, useRef, useState } from 'react';
import type { Account, AccountType } from '../../shared/types';
import { isArchived } from '../accounts';
import { api } from '../api';
import {
  centsToInput,
  cleanError,
  fmtMoney,
  nowTimeHm,
  ordinal,
  parseAmountToCents,
  parseSignedAmountToCents,
  todayStr,
} from '../format';
import { fileToAccountImage } from '../image';
import { CheckIcon, PlusIcon, TrashIcon, UploadIcon } from './Icons';
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

const DUE_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

export function AccountEditModal({
  initial,
  accounts = [],
  onClose,
  onSaved,
}: {
  initial: Account | null;
  // Existing accounts — offered as the payout destination for a new loan.
  accounts?: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<AccountType>(initial?.type ?? 'debit');
  const [color, setColor] = useState(initial?.color ?? SWATCHES[0]);
  // An account shows either a color or a custom image. `mode` drives which one
  // is saved; `image` holds the data URI when in image mode.
  const [mode, setMode] = useState<'color' | 'image'>(initial?.image ? 'image' : 'color');
  const [image, setImage] = useState<string | null>(initial?.image ?? null);
  const [imgBusy, setImgBusy] = useState(false);
  // Field holds a positive magnitude; the backend signs it by account type.
  const [opening, setOpening] = useState(
    initial ? centsToInput(Math.abs(initial.openingBalanceCents)) : ''
  );
  // Monthly payment due day(s) (credit/loan only); '' = no due date. The
  // second day covers twice-a-month plans (e.g. paid every 15th and 30th).
  const [dueDay, setDueDay] = useState<string>(
    initial?.dueDay != null ? String(initial.dueDay) : ''
  );
  const [dueDay2, setDueDay2] = useState<string>(
    initial?.dueDay2 != null ? String(initial.dueDay2) : ''
  );
  // Card details (credit only): the limit and the statement closing day.
  const [limit, setLimit] = useState(initial?.creditLimitCents ? centsToInput(initial.creditLimitCents) : '');
  const [statementDay, setStatementDay] = useState<string>(
    initial?.statementDay != null ? String(initial.statementDay) : ''
  );
  // Interest (credit and loan), typed per year or per month and stored per
  // year in basis points. An existing rate opens per year.
  const [rate, setRate] = useState(initial?.interestRateBp ? String(initial.interestRateBp / 100) : '');
  const [rateUnit, setRateUnit] = useState<'year' | 'month'>('year');
  // New-loan extras: optionally deposit the borrowed amount into a debit
  // account, with an optional transaction fee. Total owed = amount + fee;
  // only the amount reaches the destination (the fee never does).
  const [destId, setDestId] = useState('');
  const [fee, setFee] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const isNewLoan = !initial && type === 'loan';
  const debitAccounts = accounts.filter((a) => a.type === 'debit' && !isArchived(a));

  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be re-picked after a remove
    if (!file) return;
    setError('');
    setImgBusy(true);
    try {
      setImage(await fileToAccountImage(file));
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setImgBusy(false);
    }
  };

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
    let feeCents = 0;
    if (isNewLoan && fee.trim() !== '') {
      const parsedFee = parseAmountToCents(fee);
      if (parsedFee === null) {
        setError('Enter a valid transaction fee, or leave it empty');
        return;
      }
      feeCents = parsedFee;
    }
    const loanAmount = Math.abs(openingCents);
    if (isNewLoan && destId && loanAmount === 0) {
      setError('Enter the loan amount to deposit');
      return;
    }
    if (mode === 'image' && !image) {
      setError('Upload an image, or switch to Color');
      return;
    }
    const imageToSave = mode === 'image' ? image : null;
    const dueDayToSave = type !== 'debit' && dueDay !== '' ? Number(dueDay) : null;
    // No second day without a first (the server normalizes this too).
    const dueDay2ToSave =
      dueDayToSave !== null && dueDay2 !== '' && dueDay2 !== dueDay ? Number(dueDay2) : null;
    let creditLimitCents: number | null = null;
    if (type === 'credit' && limit.trim() !== '') {
      creditLimitCents = parseAmountToCents(limit);
      if (creditLimitCents === null) {
        setError('Enter the credit limit as a positive amount, or leave it empty');
        return;
      }
    }
    let interestRateBp: number | null = null;
    if (type !== 'debit' && rate.trim() !== '') {
      const pct = Number(rate.replace(/[%\s,]/g, ''));
      const yearly = Math.round(pct * 100) * (rateUnit === 'month' ? 12 : 1);
      if (!Number.isFinite(pct) || pct < 0 || yearly > 100000) {
        setError('Enter the interest rate as a percentage, e.g. 3 or 24.5, or leave it empty');
        return;
      }
      interestRateBp = yearly === 0 ? null : yearly;
    }
    const details = {
      dueDay: dueDayToSave,
      dueDay2: dueDay2ToSave,
      creditLimitCents,
      statementDay: type === 'credit' && statementDay !== '' ? Number(statementDay) : null,
      interestRateBp,
    };
    setSaving(true);
    try {
      if (initial) {
        await api.accounts.update(initial.id, {
          name: name.trim(),
          color,
          image: imageToSave,
          ...details,
          openingBalanceCents: openingCents,
        });
      } else if (isNewLoan && destId) {
        // Loan paid out to an account: the debt is recorded by the transfer
        // (opening 0) — the loan ends up owing amount + fee while the
        // destination gains only the amount (standard transfer fee math).
        const created = await api.accounts.create({
          name: name.trim(),
          type,
          color,
          image: imageToSave,
          ...details,
          openingBalanceCents: 0,
        });
        try {
          await api.transfers.create({
            fromAccountId: created.id,
            toAccountId: Number(destId),
            amountCents: loanAmount,
            feeCents,
            date: todayStr(),
            time: nowTimeHm(),
            note: 'Loan received',
          });
        } catch (err) {
          onSaved(); // the account exists — refresh lists before surfacing this
          setError(
            `Account created, but the deposit failed: ${cleanError(err)}. ` +
              'You can add the transfer manually from the Accounts page.'
          );
          setSaving(false);
          return;
        }
      } else {
        await api.accounts.create({
          name: name.trim(),
          type,
          color,
          image: imageToSave,
          ...details,
          // A fee on an untracked payout still counts toward the debt.
          openingBalanceCents: isNewLoan ? loanAmount + feeCents : openingCents,
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
          <label>Type</label>
          <div className="segmented" role="group" aria-label="Account type">
            {/* Type is immutable once set, so when editing show only the
                account's own type; when creating, offer all three. */}
            {(initial ? [type] : (Object.keys(TYPE_LABELS) as AccountType[])).map((t) => (
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
          {/* This field is the account's OPENING balance. For a new account
              that equals the current balance, but when editing an account
              with activity it does NOT — transactions/payments are applied on
              top — so the label and hint must not claim it's "current". */}
          <label htmlFor="acc-opening">{initial ? 'Starting amount' : 'Amount'}</label>
          <MoneyInput id="acc-opening" value={opening} onChange={setOpening} />
          <div className="field-hint">
            {initial
              ? type === 'debit'
                ? 'The starting balance. Transactions since are added on top to get the current balance.'
                : 'The starting amount owed. Payments and charges since adjust the current balance.'
              : type === 'debit'
                ? "The account's current balance."
                : type === 'credit'
                  ? 'How much you currently owe on this card'
                  : 'How much you currently owe / borrowed'}
          </div>
        </div>

        {type !== 'debit' && (
          <div className="field">
            <label htmlFor="acc-due-day">Payment due day (optional)</label>
            <select
              id="acc-due-day"
              value={dueDay}
              onChange={(e) => {
                setDueDay(e.target.value);
                if (e.target.value === '') setDueDay2(''); // no second day without a first
              }}
            >
              <option value="">No due date</option>
              {DUE_DAYS.map((d) => (
                <option key={d} value={d}>
                  {ordinal(d)} of every month
                </option>
              ))}
            </select>
            <div className="field-hint">
              Shows the next due date on your accounts — days 29–31 fall on the last day of
              shorter months.
            </div>
          </div>
        )}

        {type !== 'debit' && dueDay !== '' && (
          <div className="field">
            <label htmlFor="acc-due-day2">Second due day (optional)</label>
            <select id="acc-due-day2" value={dueDay2} onChange={(e) => setDueDay2(e.target.value)}>
              <option value="">None — paid once a month</option>
              {DUE_DAYS.filter((d) => String(d) !== dueDay).map((d) => (
                <option key={d} value={d}>
                  {ordinal(d)} of every month
                </option>
              ))}
            </select>
            <div className="field-hint">
              For twice-a-month plans — the accounts list always shows whichever payment is next.
            </div>
          </div>
        )}

        {type === 'credit' && (
          <div className="form-row">
            <div className="field">
              <label htmlFor="acc-limit">Credit limit (optional)</label>
              <MoneyInput id="acc-limit" value={limit} onChange={setLimit} />
              <div className="field-hint">Shows how much of the card is used and what's left.</div>
            </div>
            <div className="field">
              <label htmlFor="acc-statement-day">Statement closes (optional)</label>
              <select
                id="acc-statement-day"
                value={statementDay}
                onChange={(e) => setStatementDay(e.target.value)}
              >
                <option value="">Not set</option>
                {DUE_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {ordinal(d)} of every month
                  </option>
                ))}
              </select>
              <div className="field-hint">Purchases after this day go on the next statement.</div>
            </div>
          </div>
        )}

        {type !== 'debit' && (
          <div className="field">
            <label htmlFor="acc-rate">Interest rate (optional)</label>
            <div className="rate-input">
              <input
                id="acc-rate"
                type="text"
                inputMode="decimal"
                value={rate}
                placeholder="e.g. 3"
                onChange={(e) => setRate(e.target.value.replace(/[^0-9.]/g, ''))}
                maxLength={8}
              />
              <select
                aria-label="Interest rate period"
                value={rateUnit}
                onChange={(e) => setRateUnit(e.target.value as 'year' | 'month')}
              >
                <option value="year">% a year</option>
                <option value="month">% a month</option>
              </select>
            </div>
            <div className="field-hint">
              {type === 'credit'
                ? 'What the card charges on a balance you carry. Used to estimate interest in Schedule → Progress.'
                : 'Only if interest is charged on what you still owe. Leave empty when your installments already include it, as most installment loans do.'}
            </div>
          </div>
        )}

        {isNewLoan && (
          <>
            <div className="field">
              <label htmlFor="acc-loan-dest">Deposit to account (optional)</label>
              <select
                id="acc-loan-dest"
                value={destId}
                onChange={(e) => setDestId(e.target.value)}
              >
                <option value="">No account — just track what you owe</option>
                {debitAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({fmtMoney(a.balanceCents)})
                  </option>
                ))}
              </select>
              <div className="field-hint">
                Where the borrowed money lands. Only the loan amount is deposited — the fee never
                reaches it.
              </div>
            </div>

            <div className="field">
              <label htmlFor="acc-loan-fee">Transaction fee (optional)</label>
              <MoneyInput id="acc-loan-fee" value={fee} onChange={setFee} placeholder="0.00" />
              <div className="field-hint">
                Added to your debt: total owed = loan amount + fee.
              </div>
            </div>
          </>
        )}

        <div className="field">
          <label>Appearance</label>
          <div className="segmented" role="group" aria-label="Appearance">
            <button
              type="button"
              className={mode === 'color' ? 'active-account' : ''}
              onClick={() => setMode('color')}
            >
              Color
            </button>
            <button
              type="button"
              className={mode === 'image' ? 'active-account' : ''}
              onClick={() => setMode('image')}
            >
              Image
            </button>
          </div>

          {mode === 'color' ? (
            <div className="swatches" style={{ marginTop: 10 }}>
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
          ) : (
            <div className="image-picker">
              <div className="image-preview" style={{ background: color }}>
                {image ? (
                  <img src={image} alt="Account" />
                ) : (
                  <span className="image-preview-empty">No image</span>
                )}
              </div>
              <div className="image-picker-actions">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={onPickFile}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={imgBusy}
                >
                  <UploadIcon /> {imgBusy ? 'Processing…' : image ? 'Change image' : 'Upload image'}
                </button>
                {image && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setImage(null);
                      setMode('color');
                    }}
                  >
                    <TrashIcon /> Remove
                  </button>
                )}
              </div>
              <div className="field-hint">
                Square images look best. Large photos are resized automatically.
              </div>
            </div>
          )}
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || imgBusy}>
            {initial ? <CheckIcon /> : <PlusIcon />} {initial ? 'Save changes' : 'Create account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
