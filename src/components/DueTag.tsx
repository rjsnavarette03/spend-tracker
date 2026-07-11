import { nextDueInfo, ordinal } from '../format';

// "Due Jul 15" pill for credit/loan accounts with one or two monthly payment
// days (two = twice-a-month plans); always shows whichever payment is next.
// Turns amber within a week of the due date and red when it's ≤2 days away.
export function DueTag({ dueDay, dueDay2 }: { dueDay: number; dueDay2?: number | null }) {
  const { days, label } = nextDueInfo(dueDay, dueDay2);
  const cls = days <= 2 ? ' due-now' : days <= 7 ? ' due-soon' : '';
  const which =
    dueDay2 != null ? `${ordinal(dueDay)} and ${ordinal(dueDay2)}` : ordinal(dueDay);
  return (
    <span className={`due-tag${cls}`} title={`Payment due on the ${which} of every month`}>
      {label}
    </span>
  );
}
