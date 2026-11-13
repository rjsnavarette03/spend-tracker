import { fmtMoney, todayStr } from '../format';
import { isPastDue, KIND_LABEL, shortDateLabel } from '../schedule';
import type { DueStatus, ItemOccurrence, PaydayOccurrence, PaydayStatus } from '../schedule';
import { BanknoteIcon, PlusIcon } from './Icons';

// One due date as a line — on payday cards, the Overdue card, the calendar's
// day details and the reminders — with its status and the Mark-as-paid
// button. PaydayLine is the same line for a payday, with Log received.

/**
 * Most urgent first: settled, overdue, then a forecast shortfall ("at risk").
 * A partly paid date past its due date is overdue too, with what's left.
 */
export function dueTag(
  o: ItemOccurrence,
  st: DueStatus | undefined,
  shortCents: number,
  today: string = todayStr()
): { label: string; cls: string } | null {
  if (st?.state === 'paid') {
    return { label: st.extraCents > 0 ? `Paid +${fmtMoney(st.extraCents)}` : 'Paid', cls: 'due-ok' };
  }
  if (st?.state === 'lapsed') return { label: 'Past', cls: '' };
  if (st?.state === 'overdue') return { label: 'Overdue', cls: 'due-now' };
  if (st?.state === 'partial' && isPastDue(o, st, today)) {
    return { label: `Overdue · ${fmtMoney(st.remainingCents)} left`, cls: 'due-now' };
  }
  if (shortCents > 0) return { label: `Short ${fmtMoney(shortCents)}`, cls: 'due-now' };
  if (o.item.kind === 'subscription') return { label: 'Auto-charged', cls: '' };
  if (st?.state === 'partial') return { label: `${fmtMoney(st.remainingCents)} left`, cls: 'due-soon' };
  if (st?.state === 'today') return { label: 'Due today', cls: 'due-soon' };
  return null;
}

/** One due date on a card: status, amount, and the Mark-as-paid button. */
export function PlanLine({
  occurrence: o,
  status,
  shortCents,
  onPay,
}: {
  occurrence: ItemOccurrence;
  status: DueStatus | undefined;
  shortCents: number; // from the cash forecast; 0 = covered
  onPay: () => void;
}) {
  const tag = dueTag(o, status, shortCents);
  const paid = status?.state === 'paid';
  return (
    <div className={`plan-line ${paid ? 'plan-line-paid' : ''}`}>
      <span className="plan-line-date">{shortDateLabel(o.dueDate)}</span>
      <span className="plan-line-name">
        <span>{o.item.name}</span>
        <span className="type-tag sub-tag plan-kind">{KIND_LABEL[o.item.kind]}</span>
        {tag && <span className={`due-tag ${tag.cls}`}>{tag.label}</span>}
      </span>
      <span className="num plan-line-amount">
        {o.item.amountMode === 'avg3' ? '≈ ' : ''}
        {fmtMoney(o.amountCents)}
      </span>
      <span className="plan-line-action">
        {o.item.kind === 'subscription' ? null : paid ? (
          <button className="btn-icon" title="Pay extra" onClick={onPay}>
            <PlusIcon />
          </button>
        ) : (
          <button className="btn-icon plan-pay" title="Mark as paid" onClick={onPay}>
            <BanknoteIcon />
          </button>
        )}
      </span>
    </div>
  );
}

function paydayTag(status: PaydayStatus): { label: string; cls: string } | null {
  if (status.state === 'received') return { label: 'Received', cls: 'due-ok' };
  if (status.state === 'unlogged') return { label: 'Not logged', cls: 'due-soon' };
  if (status.state === 'today') return { label: 'Today', cls: 'due-soon' };
  return null;
}

/** One payday as a line: expected (or received) amount and Log received. */
export function PaydayLine({
  payday,
  status,
  onLog,
}: {
  payday: PaydayOccurrence;
  status: PaydayStatus;
  onLog: () => void;
}) {
  const tag = paydayTag(status);
  const received = status.state === 'received';
  return (
    <div className="plan-line">
      <span className="plan-line-date">{shortDateLabel(payday.date)}</span>
      <span className="plan-line-name">
        <span>{payday.item.name}</span>
        <span className="type-tag sub-tag plan-kind">Payday</span>
        {tag && <span className={`due-tag ${tag.cls}`}>{tag.label}</span>}
      </span>
      <span className={`num plan-line-amount ${received ? 'amount-income' : ''}`}>
        {fmtMoney(received ? status.receivedCents : payday.item.amountCents)}
      </span>
      <span className="plan-line-action">
        <button
          className={`btn-icon ${received ? '' : 'plan-pay'}`}
          title={received ? 'Log another amount' : 'Log received'}
          onClick={onLog}
        >
          {received ? <PlusIcon /> : <BanknoteIcon />}
        </button>
      </span>
    </div>
  );
}
