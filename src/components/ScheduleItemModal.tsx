import { FormEvent, useEffect, useMemo, useState } from 'react';
import type {
  Account,
  Category,
  ScheduleAmountMode,
  ScheduleItem,
  ScheduleItemInput,
  Subscription,
  Transaction,
  Transfer,
} from '../../shared/types';
import { isArchived } from '../accounts';
import { api } from '../api';
import { centsToInput, cleanError, dateLabel, fmtMoney, ordinal, parseAmountToCents, todayStr } from '../format';
import {
  estimateWindow,
  itemOccurrences,
  monthlyDueDays,
  nthOccurrenceDate,
  remainingCount,
  shortDateLabel,
  WEEKDAY_LABEL,
  windowLabel,
} from '../schedule';
import { CheckIcon, PlusIcon, TrashIcon } from './Icons';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

// Add/edit a planned outflow on the Schedule page. Loans and cards read their
// balance and due days from the account (never typed here); the per-payment
// amount is prefilled from the last payment into that account.
export type OutflowKind = 'loan' | 'card' | 'bill' | 'allowance' | 'savings';
type EndMode = 'none' | 'count' | 'date';

const KIND_OPTIONS: Array<[OutflowKind, string]> = [
  ['loan', 'Loan installment'],
  ['card', 'Credit card payment'],
  ['bill', 'Bill'],
  ['allowance', 'Weekly allowance'],
  ['savings', 'Savings goal'],
];

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1);

function dueDaysText(days: number[]): string {
  return days.map((d) => ordinal(d)).join(' and ');
}

export function ScheduleItemModal({
  initial,
  preset,
  accounts,
  categories,
  paydays,
  subscriptions,
  scheduledAccountIds,
  onClose,
  onSaved,
}: {
  initial: ScheduleItem | null;
  preset: { kind: OutflowKind; accountId?: number } | null; // "Add to schedule" on an account
  accounts: Account[];
  categories: Category[];
  paydays: ScheduleItem[];
  subscriptions: Subscription[];
  scheduledAccountIds: number[]; // loans/cards already on the schedule (one item each)
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = todayStr();
  const ctx = useMemo(() => ({ accounts, subscriptions }), [accounts, subscriptions]);
  const startKind: OutflowKind = (initial?.kind as OutflowKind | undefined) ?? preset?.kind ?? 'loan';
  const initialLeft = initial ? remainingCount(initial, ctx, today) : null;
  const defaultPayFrom =
    paydays.find((p) => p.accountId != null)?.accountId ?? accounts.find((a) => a.type === 'debit' && !isArchived(a))?.id ?? null;

  const [kind, setKind] = useState<OutflowKind>(startKind);
  const [accountId, setAccountId] = useState<string>(
    initial?.accountId != null ? String(initial.accountId) : preset?.accountId != null ? String(preset.accountId) : ''
  );
  const [name, setName] = useState(initial?.name ?? '');
  const [nameTouched, setNameTouched] = useState(initial !== null);
  const [categoryId, setCategoryId] = useState(initial?.categoryId != null ? String(initial.categoryId) : '');
  const [amountMode, setAmountMode] = useState<ScheduleAmountMode>(initial?.amountMode ?? 'fixed');
  const [amount, setAmount] = useState(initial && initial.amountCents > 0 ? centsToInput(initial.amountCents) : '');
  const [amountTouched, setAmountTouched] = useState(initial !== null);
  const [keyword, setKeyword] = useState(initial?.matchKeyword ?? '');
  const [dueDay, setDueDay] = useState(initial?.dueDay != null ? String(initial.dueDay) : '');
  const [weekDay, setWeekDay] = useState(initial?.weekDay != null ? String(initial.weekDay) : '');
  const [fundedBy, setFundedBy] = useState(initial?.fundedBy != null ? String(initial.fundedBy) : '');
  const [payFrom, setPayFrom] = useState<string>(
    initial
      ? initial.payFromAccountId != null
        ? String(initial.payFromAccountId)
        : ''
      : defaultPayFrom != null
        ? String(defaultPayFrom)
        : ''
  );
  const [goal, setGoal] = useState(initial?.goalCents != null ? centsToInput(initial.goalCents) : '');
  const [milestones, setMilestones] = useState<string[]>(() => (initial?.goalMilestones ?? []).map(centsToInput));
  // Editing shows "N payments left" when the end date is still ahead.
  const [endMode, setEndMode] = useState<EndMode>(
    initial
      ? initial.endDate === null
        ? 'none'
        : initialLeft
          ? 'count'
          : 'date'
      : startKind === 'loan'
        ? 'count'
        : 'none'
  );
  const [endCount, setEndCount] = useState(initialLeft ? String(initialLeft) : '');
  const [endDate, setEndDate] = useState(initial?.endDate ?? '');
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [categoryTx, setCategoryTx] = useState<Transaction[] | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // A loan/card is scheduled once; several savings goals may share an account.
  const targetAccounts = useMemo(
    () =>
      accounts.filter(
        (a) =>
          a.type === (kind === 'loan' ? 'loan' : kind === 'card' ? 'credit' : 'debit') &&
          (!isArchived(a) || a.id === initial?.accountId) &&
          (kind === 'savings' || a.id === initial?.accountId || !scheduledAccountIds.includes(a.id))
      ),
    [accounts, kind, initial, scheduledAccountIds]
  );
  const usesAccount = kind === 'loan' || kind === 'card' || kind === 'savings';
  const target = usesAccount ? accounts.find((a) => a.id === Number(accountId)) : undefined;
  const owedCents = target && target.balanceCents < 0 ? -target.balanceCents : 0;
  const expenseCategories = useMemo(() => categories.filter((c) => c.type === 'expense'), [categories]);
  const sources = accounts.filter(
    (a) =>
      (a.type === 'debit' || a.type === 'credit') &&
      a.id !== target?.id &&
      (!isArchived(a) || a.id === initial?.payFromAccountId)
  );

  // Loans/cards are named after their account until the user types a name.
  const autoName = (kind === 'loan' || kind === 'card') && target ? target.name : '';
  const shownName = nameTouched ? name : autoName || name;

  // Recent payments, to prefill the per-payment amount.
  useEffect(() => {
    api.transfers
      .list()
      .then(setTransfers)
      .catch(() => {
        /* prefill is a convenience; the form works without it */
      });
  }, []);
  const lastPayment = useMemo(
    () => transfers.find((t) => t.toAccountId === Number(accountId) && t.fromAccountId !== null),
    [transfers, accountId]
  );
  useEffect(() => {
    if (amountTouched || (kind !== 'loan' && kind !== 'card')) return;
    // Cards default to paying what's owed now; loans to the last installment paid.
    const cents = kind === 'card' && owedCents > 0 ? owedCents : lastPayment?.amountCents;
    setAmount(cents ? centsToInput(cents) : '');
  }, [kind, accountId, lastPayment, owedCents, amountTouched]);

  // Live 3-month estimate preview for bills (the server recomputes it on save).
  const win = useMemo(() => estimateWindow(today), [today]);
  useEffect(() => {
    if (kind !== 'bill' || amountMode !== 'avg3' || !categoryId) {
      setCategoryTx(null);
      return;
    }
    let cancelled = false;
    api.transactions
      .list({ categoryId: Number(categoryId), type: 'expense', from: win[0], to: win[1] })
      .then((rows) => {
        if (!cancelled) setCategoryTx(rows);
      })
      .catch(() => {
        /* preview only */
      });
    return () => {
      cancelled = true;
    };
  }, [kind, amountMode, categoryId, win]);
  const needle = keyword.trim().toLowerCase();
  const matchedBills = (categoryTx ?? []).filter((t) => !needle || t.note.toLowerCase().includes(needle));
  const estimateCents = matchedBills.length
    ? Math.round(matchedBills.reduce((s, t) => s + t.amountCents, 0) / 3)
    : null;

  const parsedAmount = parseAmountToCents(amount);
  // The item as it would be saved, for due-date previews.
  const draft: ScheduleItem = {
    id: initial?.id ?? 0,
    name: shownName,
    kind,
    accountId: usesAccount && accountId ? Number(accountId) : null,
    subscriptionId: null,
    categoryId: categoryId ? Number(categoryId) : null,
    amountMode,
    amountCents: parsedAmount ?? 0,
    matchKeyword: null,
    dueDay: dueDay ? Number(dueDay) : null,
    weekDay: weekDay !== '' ? Number(weekDay) : null,
    fundedBy: null,
    weekendShift: 'none',
    startDate: today,
    endDate: null,
    goalCents: null,
    goalMilestones: [],
    payFromAccountId: null,
    active: true,
    estimateCents: null,
    estimateFrom: null,
    estimateTo: null,
  };
  const accountDueDays = target && kind !== 'savings' ? monthlyDueDays(draft, accounts) : [];
  const nextDue = nthOccurrenceDate(draft, ctx, today, 1);
  const count = Number(endCount);
  const countValid = Number.isInteger(count) && count >= 1 && count <= 600;
  const lastByCount = endMode === 'count' && countValid ? nthOccurrenceDate(draft, ctx, today, count) : null;
  const countByDate =
    endMode === 'date' && endDate >= today ? itemOccurrences({ ...draft, endDate }, ctx, today, endDate).length : null;
  const suggestedLeft =
    kind === 'loan' && owedCents > 0 && parsedAmount ? Math.ceil(owedCents / parsedAmount) : null;

  const changeKind = (k: OutflowKind) => {
    setKind(k);
    setAccountId('');
    setEndMode(k === 'loan' ? 'count' : 'none');
    setEndCount('');
    if (!amountTouched) setAmount('');
    setError('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const fail = (msg: string) => setError(msg);
    if (usesAccount && !target) {
      return fail(kind === 'loan' ? 'Pick the loan' : kind === 'card' ? 'Pick the credit card' : 'Pick the account your savings go into');
    }
    if ((kind === 'loan' || kind === 'card') && accountDueDays.length === 0) {
      return fail(`${target?.name} has no due day yet — set it on the Accounts page (Edit), then add it here.`);
    }
    if (!shownName.trim()) return fail('Give it a name, e.g. Electricity');
    if (kind === 'bill' && !categoryId) return fail('Pick the expense category this bill is recorded under');
    if ((kind === 'bill' || kind === 'savings') && !dueDay) return fail('Pick the day of the month');
    if (kind === 'allowance' && weekDay === '') return fail('Pick the day of the week');
    const avg3 = kind === 'bill' && amountMode === 'avg3';
    if (!avg3 && parsedAmount === null) return fail('Enter a positive amount, e.g. 8,800.00');
    if (avg3 && amount.trim() !== '' && parsedAmount === null) return fail('The fallback amount must be positive, or leave it empty');
    let goalCents: number | null = null;
    if (kind === 'savings' && goal.trim() !== '') {
      goalCents = parseAmountToCents(goal);
      if (goalCents === null) return fail('The goal must be a positive amount, or leave it empty');
    }
    const milestoneCents: number[] = [];
    if (kind === 'savings') {
      for (const m of milestones) {
        if (m.trim() === '') continue;
        const cents = parseAmountToCents(m);
        if (cents === null) return fail('Each milestone must be a positive amount (remove empty ones)');
        milestoneCents.push(cents);
      }
      if (goalCents !== null && milestoneCents.some((c) => c > goalCents!)) {
        return fail("Milestones can't be above the goal");
      }
    }
    let end: string | null = null;
    if (endMode === 'count') {
      if (!countValid) return fail('Enter how many payments are left (1 or more)');
      end = lastByCount;
      if (end === null) return fail("Couldn't work out the last due date — check the due day");
    } else if (endMode === 'date') {
      if (!endDate) return fail('Pick the date of the last payment');
      end = endDate;
    }

    const data: ScheduleItemInput = {
      kind,
      name: shownName.trim(),
      accountId: usesAccount ? Number(accountId) : null,
      subscriptionId: null,
      categoryId: (kind === 'bill' || kind === 'allowance') && categoryId ? Number(categoryId) : null,
      amountMode: kind === 'bill' ? amountMode : 'fixed',
      amountCents: parsedAmount ?? 0,
      matchKeyword: kind === 'bill' && keyword.trim() ? keyword.trim() : null,
      dueDay: kind === 'bill' || kind === 'savings' ? Number(dueDay) : null,
      weekDay: kind === 'allowance' ? Number(weekDay) : null,
      fundedBy: kind !== 'allowance' && fundedBy ? Number(fundedBy) : null,
      weekendShift: 'none',
      startDate: null,
      endDate: end,
      goalCents,
      goalMilestones: milestoneCents,
      payFromAccountId: payFrom ? Number(payFrom) : null,
      active: initial?.active ?? true,
    };
    setSaving(true);
    try {
      if (initial) await api.schedule.updateItem(initial.id, data);
      else await api.schedule.createItem(data);
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  const amountLabel =
    kind === 'allowance' ? 'Amount per week' : kind === 'savings' ? 'Amount each month' : 'Amount per due date';

  return (
    <Modal title={initial ? `Edit ${initial.name}` : 'Add to schedule'} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        {!initial && (
          <div className="field">
            <label htmlFor="item-kind">What is it?</label>
            <select id="item-kind" value={kind} onChange={(e) => changeKind(e.target.value as OutflowKind)}>
              {KIND_OPTIONS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}

        {usesAccount && (
          <div className="field">
            <label htmlFor="item-account">
              {kind === 'loan' ? 'Loan' : kind === 'card' ? 'Credit card' : 'Goes into'}
            </label>
            <select id="item-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="" disabled>
                {targetAccounts.length
                  ? 'Pick an account'
                  : kind !== 'savings' && accounts.some((a) => a.type === (kind === 'loan' ? 'loan' : 'credit'))
                    ? `All your ${kind === 'loan' ? 'loans' : 'cards'} are already scheduled`
                    : `No ${kind === 'loan' ? 'loan' : kind === 'card' ? 'credit' : 'debit'} accounts yet`}
              </option>
              {targetAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.balanceCents < 0 ? ` — owes ${fmtMoney(-a.balanceCents)}` : ` (${fmtMoney(a.balanceCents)})`}
                </option>
              ))}
            </select>
            {target && kind !== 'savings' && (
              <div className="field-hint">
                {owedCents > 0 ? `Owes ${fmtMoney(owedCents)}` : 'Nothing owed right now'}
                {accountDueDays.length > 0
                  ? ` · due on the ${dueDaysText(accountDueDays)} (from the account)`
                  : ' · no due day set — add one on the Accounts page'}
                {lastPayment && ` · last payment ${fmtMoney(lastPayment.amountCents)} on ${shortDateLabel(lastPayment.date)}`}
              </div>
            )}
          </div>
        )}

        <div className="field">
          <label htmlFor="item-name">Name</label>
          <input
            id="item-name"
            type="text"
            value={shownName}
            maxLength={60}
            placeholder={
              kind === 'bill' ? 'e.g. Electricity' : kind === 'allowance' ? 'e.g. Household' : kind === 'savings' ? 'e.g. Emergency fund' : ''
            }
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
          />
        </div>

        {(kind === 'bill' || kind === 'allowance') && (
          <div className="form-row">
            <div className="field">
              <label htmlFor="item-category">{kind === 'bill' ? 'Category' : 'Category (optional)'}</label>
              <select id="item-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{kind === 'bill' ? 'Pick a category' : 'Uncategorized'}</option>
                {expenseCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            {kind === 'bill' ? (
              <div className="field">
                <label htmlFor="item-day">Due day</label>
                <select id="item-day" value={dueDay} onChange={(e) => setDueDay(e.target.value)}>
                  <option value="" disabled>
                    Pick a day
                  </option>
                  {DAYS_OF_MONTH.map((d) => (
                    <option key={d} value={d}>
                      {ordinal(d)}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="item-weekday">Every</label>
                <select id="item-weekday" value={weekDay} onChange={(e) => setWeekDay(e.target.value)}>
                  <option value="" disabled>
                    Pick a day
                  </option>
                  {WEEKDAY_LABEL.map((label, i) => (
                    <option key={label} value={i}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {kind === 'bill' && (
          <div className="field">
            <label>Amount</label>
            <div className="segmented" role="group" aria-label="Amount">
              <button
                type="button"
                className={amountMode === 'fixed' ? 'active-account' : ''}
                onClick={() => setAmountMode('fixed')}
              >
                Fixed amount
              </button>
              <button
                type="button"
                className={amountMode === 'avg3' ? 'active-account' : ''}
                onClick={() => setAmountMode('avg3')}
              >
                3-month average
              </button>
            </div>
          </div>
        )}

        {kind === 'bill' && amountMode === 'avg3' ? (
          <>
            <div className="form-row">
              <div className="field">
                <label htmlFor="item-keyword">Only notes containing (optional)</label>
                <input
                  id="item-keyword"
                  type="text"
                  value={keyword}
                  maxLength={60}
                  placeholder="e.g. Meralco"
                  onChange={(e) => setKeyword(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="item-amount">Fallback amount (optional)</label>
                <MoneyInput
                  id="item-amount"
                  value={amount}
                  onChange={(v) => {
                    setAmount(v);
                    setAmountTouched(true);
                  }}
                />
              </div>
            </div>
            <div className="field-hint">
              {!categoryId
                ? 'Pick the category the bill is recorded under to see the estimate.'
                : categoryTx === null
                  ? 'Calculating…'
                  : estimateCents !== null
                    ? `≈ ${fmtMoney(estimateCents)} a month — the average of ${matchedBills.length} matching ${matchedBills.length === 1 ? 'bill' : 'bills'} over ${windowLabel(win)}. Updates every month.`
                    : `No ${needle ? `"${keyword.trim()}" ` : ''}bills in this category over ${windowLabel(win)} yet — the fallback amount is used until there are.`}
            </div>
          </>
        ) : (
          <div className="form-row">
            <div className="field">
              <label htmlFor="item-amount">{amountLabel}</label>
              <MoneyInput
                id="item-amount"
                value={amount}
                onChange={(v) => {
                  setAmount(v);
                  setAmountTouched(true);
                }}
              />
            </div>
            {kind === 'savings' ? (
              <div className="field">
                <label htmlFor="item-day">Day of the month</label>
                <select id="item-day" value={dueDay} onChange={(e) => setDueDay(e.target.value)}>
                  <option value="" disabled>
                    Pick a day
                  </option>
                  {DAYS_OF_MONTH.map((d) => (
                    <option key={d} value={d}>
                      {ordinal(d)}
                    </option>
                  ))}
                </select>
              </div>
            ) : kind === 'bill' ? (
              <div className="field">
                <label htmlFor="item-keyword">Note contains (optional)</label>
                <input
                  id="item-keyword"
                  type="text"
                  value={keyword}
                  maxLength={60}
                  placeholder="e.g. Maynilad"
                  onChange={(e) => setKeyword(e.target.value)}
                />
              </div>
            ) : (
              <div className="field" aria-hidden="true" />
            )}
          </div>
        )}
        {kind === 'bill' && amountMode === 'fixed' && (
          <div className="field-hint">
            A {categories.find((c) => c.id === Number(categoryId))?.name ?? 'category'} expense you add
            on the Transactions page counts as paying this bill
            {keyword.trim() ? ` when its note contains "${keyword.trim()}"` : ' — add a keyword if other bills share the category'}.
          </div>
        )}

        {kind === 'savings' && (
          <>
            <div className="field">
              <label htmlFor="item-goal">Goal (optional)</label>
              <MoneyInput id="item-goal" value={goal} onChange={setGoal} />
            </div>
            <div className="field">
              <label>Milestones (optional)</label>
              {milestones.map((m, i) => (
                <div className="milestone-row" key={i}>
                  <MoneyInput
                    id={`item-milestone-${i}`}
                    ariaLabel={`Milestone ${i + 1}`}
                    value={m}
                    onChange={(v) => setMilestones((ms) => ms.map((x, j) => (j === i ? v : x)))}
                  />
                  <button
                    type="button"
                    className="btn-icon danger"
                    title="Remove milestone"
                    onClick={() => setMilestones((ms) => ms.filter((_, j) => j !== i))}
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
              {milestones.length < 8 && (
                <button type="button" className="btn milestone-add" onClick={() => setMilestones((ms) => [...ms, ''])}>
                  <PlusIcon /> Add milestone
                </button>
              )}
              <div className="field-hint">
                Checkpoints on the way, e.g. 10,000 · 30,000 · 60,000. With no goal set, the largest
                milestone is the goal.
              </div>
            </div>
          </>
        )}

        <div className="field">
          <label>Ends</label>
          <div className="segmented" role="group" aria-label="Ends">
            <button type="button" className={endMode === 'none' ? 'active-account' : ''} onClick={() => setEndMode('none')}>
              No end
            </button>
            <button type="button" className={endMode === 'count' ? 'active-account' : ''} onClick={() => setEndMode('count')}>
              After N payments
            </button>
            <button type="button" className={endMode === 'date' ? 'active-account' : ''} onClick={() => setEndMode('date')}>
              On a date
            </button>
          </div>
        </div>
        {endMode === 'count' && (
          <div className="field">
            <label htmlFor="item-count">Payments left (including the next one)</label>
            <input
              id="item-count"
              type="number"
              min={1}
              max={600}
              value={endCount}
              onChange={(e) => setEndCount(e.target.value)}
            />
            <div className="field-hint">
              {lastByCount && `Last payment ${dateLabel(lastByCount)}. `}
              {suggestedLeft !== null && suggestedLeft !== count && (
                <>
                  {fmtMoney(owedCents)} owed ÷ {fmtMoney(parsedAmount ?? 0)} ≈ {suggestedLeft} payments.{' '}
                  <button type="button" className="link-button" onClick={() => setEndCount(String(suggestedLeft))}>
                    Use {suggestedLeft}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {endMode === 'date' && (
          <div className="field">
            <label htmlFor="item-end">Last payment on</label>
            <input id="item-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            {countByDate !== null && (
              <div className="field-hint">
                {countByDate} {countByDate === 1 ? 'payment' : 'payments'} from today.
              </div>
            )}
          </div>
        )}

        <div className="form-row">
          <div className="field">
            <label htmlFor="item-from">Pay from</label>
            <select id="item-from" value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
              <option value="">Choose when paying</option>
              {sources.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          {kind !== 'allowance' ? (
            <div className="field">
              <label htmlFor="item-funded">Funded by</label>
              <select id="item-funded" value={fundedBy} onChange={(e) => setFundedBy(e.target.value)}>
                <option value="">Automatic</option>
                {paydays.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="field" aria-hidden="true" />
          )}
        </div>
        <div className="field-hint">
          {kind === 'allowance'
            ? 'Each week is covered by the payday before it.'
            : 'Automatic = the latest payday on or before each due date.'}
          {nextDue && ` Next due ${shortDateLabel(nextDue)}.`}
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {initial ? <CheckIcon /> : <PlusIcon />} {initial ? 'Save changes' : 'Add to schedule'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
