import { useMemo, useState } from 'react';
import type { ScheduleData, ScheduleItem } from '../../shared/types';
import { dateLabel, fmtMoney, fmtRate, parseAmountToCents } from '../format';
import { bestExtraTarget, buildDebtPlan, daysBetween, KIND_LABEL } from '../schedule';
import type { DebtLine, DebtPlan, ScheduleContext } from '../schedule';
import { MoneyInput } from './MoneyInput';
import { StepChart } from './StepChart';

// Debt payoff on the Schedule's Progress tab: when every scheduled loan/card
// balance reaches zero, total owed over time, each debt's payoff, and a
// what-if for an extra payment this month. Balances are live, so a real
// extra payment (Mark as paid with more than is due) moves the dates by itself.
// A card or loan with an interest rate also gets its projected interest, and
// the what-if says where the extra does the most good.

/** "3 months" / "12 days" — how far apart two dates are, rounded for reading. */
function gap(from: string, to: string): string {
  const days = Math.abs(daysBetween(from, to));
  // Due dates a month apart are 28–31 days apart; call that "1 month".
  if (days < 28) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.max(1, Math.round(days / 30.44));
  return `${months} month${months === 1 ? '' : 's'}`;
}

/** The debt whose payoff decides the debt-free date — the natural place for an extra payment. */
function lastToFinish(plan: DebtPlan): DebtLine | undefined {
  return plan.debts
    .filter((d) => d.item !== null && d.owedCents > 0)
    .sort((a, b) => (b.payoffDate ?? '9999').localeCompare(a.payoffDate ?? '9999'))[0];
}

export function DebtPayoff({
  items,
  data,
  ctx,
  today,
  onSetup,
}: {
  items: ScheduleItem[];
  data: ScheduleData;
  ctx: ScheduleContext;
  today: string;
  onSetup: () => void;
}) {
  const plan = useMemo(() => buildDebtPlan(items, data, ctx, today), [items, data, ctx, today]);
  const scheduled = plan.debts.filter((d) => d.item !== null && d.owedCents > 0);
  const unscheduled = plan.debts.filter((d) => d.item === null);
  const shortfalls = scheduled.filter((d) => d.leftoverCents > 0);

  const [extra, setExtra] = useState('');
  const [targetId, setTargetId] = useState<string>(''); // '' = not picked: follow the best target
  const extraCents = parseAmountToCents(extra);
  const best = useMemo(
    () => (extraCents ? bestExtraTarget(items, data, ctx, today, extraCents) : null),
    [items, data, ctx, today, extraCents]
  );
  const bestDebt = best ? scheduled.find((d) => d.account.id === best.accountId) : undefined;
  const target = scheduled.find((d) => d.account.id === Number(targetId)) ?? bestDebt ?? lastToFinish(plan);
  const whatIf = useMemo(
    () =>
      extraCents && target
        ? buildDebtPlan(items, data, ctx, today, { accountId: target.account.id, amountCents: extraCents })
        : null,
    [items, data, ctx, today, extraCents, target]
  );

  if (plan.debts.length === 0) {
    return (
      <div className="panel fc-ok">
        No loan or credit card balances owed — you're debt-free.
      </div>
    );
  }

  const summary = plan.debtFreeDate
    ? `Total owed falls from ${fmtMoney(plan.points[0].totalCents)} today to zero on ${dateLabel(plan.debtFreeDate)}.`
    : `Total owed by scheduled debts: ${fmtMoney(plan.points[0].totalCents)} today.`;

  let result: string | null = null;
  if (whatIf && target && extraCents) {
    const before = target;
    const after = whatIf.debts.find((d) => d.account.id === target.account.id);
    if (after && after.owedCents === 0) {
      result = `That clears ${target.account.name} today.`;
    }
    if (plan.debtFreeDate && whatIf.debtFreeDate && whatIf.debtFreeDate < plan.debtFreeDate) {
      result =
        (result ? `${result} ` : '') +
        `Your debt-free date moves from ${dateLabel(plan.debtFreeDate)} to ${dateLabel(whatIf.debtFreeDate)} — ${gap(whatIf.debtFreeDate, plan.debtFreeDate)} sooner.`;
    } else if (after && before.payoffDate && after.payoffDate && after.payoffDate < before.payoffDate) {
      result =
        (result ? `${result} ` : '') +
        `${target.account.name} is paid off ${dateLabel(after.payoffDate)} instead of ${dateLabel(before.payoffDate)}` +
        (plan.debtFreeDate ? `, but your debt-free date stays ${dateLabel(plan.debtFreeDate)}.` : '.');
    } else if (!result && after) {
      result =
        `Same dates — the extra is less than one payment, so ${target.account.name}'s last payment ` +
        `drops from ${fmtMoney(before.lastPaymentCents)} to ${fmtMoney(after.lastPaymentCents)}.`;
    }
    const saved = plan.interestCents - whatIf.interestCents;
    if (saved > 0) result = `${result ? `${result} ` : ''}It saves about ${fmtMoney(saved)} in interest.`;
  }

  // Where the extra would do more good than on the chosen debt, if anywhere.
  let advice: { text: string; switchTo: number | null } | null = null;
  if (best && bestDebt && target && whatIf) {
    const savedHere = Math.max(0, plan.interestCents - whatIf.interestCents);
    const soonerHere =
      plan.debtFreeDate && whatIf.debtFreeDate ? Math.max(0, daysBetween(whatIf.debtFreeDate, plan.debtFreeDate)) : 0;
    const better = best.savedCents > savedHere || (best.savedCents === savedHere && best.daysSooner > soonerHere);
    if (best.accountId === target.account.id || !better) {
      advice = { text: `${target.account.name} is where this extra does the most good.`, switchTo: null };
    } else {
      const why =
        best.savedCents > savedHere
          ? `it would save about ${fmtMoney(best.savedCents)} in interest${savedHere > 0 ? ` instead of ${fmtMoney(savedHere)}` : ''}`
          : `you'd be debt-free ${best.daysSooner} day${best.daysSooner === 1 ? '' : 's'} sooner`;
      advice = { text: `Better on ${bestDebt.account.name}: ${why}.`, switchTo: bestDebt.account.id };
    }
  }
  const anyRate = scheduled.some((d) => d.rateBp !== null);

  return (
    <>
      <div className="panel subs-summary sched-summary">
        <div className="subs-summary-item">
          <span className="subs-summary-label">Debt-free by</span>
          <span className="subs-summary-value">{plan.debtFreeDate ? dateLabel(plan.debtFreeDate) : '—'}</span>
          {plan.debtFreeDate && <span className="sub-next-muted">in {gap(today, plan.debtFreeDate)}</span>}
        </div>
        <div className="subs-summary-item">
          <span className="subs-summary-label">Owed now</span>
          <span className="subs-summary-value num">{fmtMoney(plan.owedCents)}</span>
        </div>
        <div className="subs-summary-item">
          <span className="subs-summary-label">Debts</span>
          <span className="subs-summary-value">{plan.debts.length}</span>
        </div>
        {plan.interestCents > 0 && (
          <div className="subs-summary-item">
            <span className="subs-summary-label">Interest to come</span>
            <span className="subs-summary-value num">≈ {fmtMoney(plan.interestCents)}</span>
            <span className="sub-next-muted">on your current payments</span>
          </div>
        )}
      </div>
      {(unscheduled.length > 0 || shortfalls.length > 0) && (
        <div className="field-hint sched-note">
          {unscheduled.map((d) => (
            <div key={d.account.id}>
              {d.account.name} (owes {fmtMoney(d.owedCents)}) isn't on the schedule, so it's left out of the
              debt-free date.{' '}
              <button type="button" className="link-button" onClick={onSetup}>
                Add it in Setup
              </button>
            </div>
          ))}
          {shortfalls.map((d) =>
            d.growing ? (
              <div key={d.account.id}>
                {d.account.name}: {fmtMoney(d.paymentCents ?? 0)} per due date doesn't cover its interest, so the
                balance keeps growing. Raise the payment in Setup.
              </div>
            ) : (
              <div key={d.account.id}>
                {d.account.name} still owes {fmtMoney(d.leftoverCents)} after its last scheduled payment — check its
                payments left in Setup.
              </div>
            )
          )}
        </div>
      )}

      {plan.points.length > 1 && (
        <div className="panel mt-panel">
          <div className="panel-title">Total owed over time</div>
          <StepChart
            ariaLabel={summary}
            points={plan.points.map((p) => ({
              date: p.date,
              valueCents: p.totalCents,
              tip: [
                ...(p.interestCents > 0 ? [{ amount: `+${fmtMoney(p.interestCents)}`, text: 'interest' }] : []),
                ...p.payments.map((x) => ({ amount: `−${fmtMoney(x.amountCents)}`, text: x.name })),
              ],
            }))}
          />
        </div>
      )}

      <div className="panel mt-panel">
        <div className="panel-title">Debts</div>
        {plan.debts.map((d) => (
          <div className="sub-row sched-rule" key={d.account.id}>
            <div className="sub-main">
              <div className="sub-name">
                {d.account.name}
                <span className="type-tag sub-tag">{d.item ? KIND_LABEL[d.item.kind] : d.account.type === 'loan' ? 'Loan' : 'Card'}</span>
              </div>
              <div className="sub-meta">
                {d.item && d.paymentCents !== null
                  ? `${fmtMoney(d.paymentCents)} per due date · ${d.paymentsLeft} ${d.paymentsLeft === 1 ? 'payment' : 'payments'} left` +
                    (d.paymentsLeft > 1 && d.lastPaymentCents !== d.paymentCents ? ` (last one ${fmtMoney(d.lastPaymentCents)})` : '')
                  : 'Not on the schedule'}
                {d.rateBp !== null && ` · ${fmtRate(d.rateBp)} a year`}
                {d.interestCents > 0 && ` · about ${fmtMoney(d.interestCents)} interest to come`}
              </div>
            </div>
            <div className="sub-right">
              <span className="sub-amount num">{fmtMoney(d.owedCents)}</span>
              {d.payoffDate ? (
                <span className="due-tag due-ok">Paid off {dateLabel(d.payoffDate)}</span>
              ) : d.growing ? (
                <span className="due-tag due-now">Payment is less than the interest</span>
              ) : (
                <span className="due-tag due-soon">{d.item ? 'Not paid off by the schedule' : 'No payoff date'}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {scheduled.length > 0 && (
        <div className="panel mt-panel form-grid">
          <div className="panel-title" style={{ marginBottom: 0 }}>
            What if I pay extra this month?
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor="whatif-amount">Extra amount</label>
              <MoneyInput id="whatif-amount" value={extra} onChange={setExtra} />
            </div>
            <div className="field">
              <label htmlFor="whatif-debt">On</label>
              <select
                id="whatif-debt"
                value={target ? String(target.account.id) : ''}
                onChange={(e) => setTargetId(e.target.value)}
              >
                {scheduled.map((d) => (
                  <option key={d.account.id} value={d.account.id}>
                    {d.account.name}
                    {d.rateBp !== null ? ` (${fmtRate(d.rateBp)} a year)` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className={result ? 'whatif-result' : 'field-hint'} role="status">
            {result ?? 'Enter an amount to see how much sooner you could be debt-free.'}
          </div>
          {advice && (
            <div className="field-hint whatif-advice" role="status">
              {advice.text}{' '}
              {advice.switchTo !== null && (
                <button type="button" className="link-button" onClick={() => setTargetId(String(advice.switchTo))}>
                  Try it there
                </button>
              )}
            </div>
          )}
          <div className="field-hint">
            Assumes an extra payment shortens the loan rather than lowering the installment. To make it real,
            use Mark as paid on the planner and enter more than what's due.
            {anyRate &&
              ' Interest is an estimate: the yearly rate on what is still owed, added at each due date. Your lender may count it differently.'}
          </div>
        </div>
      )}
    </>
  );
}
