import { fmtMoney } from '../format';
import { shortDateLabel } from '../schedule';
import type { ForecastDay } from '../schedule';
import { StepChart } from './StepChart';

// Projected cash on hand, one point per day, with a red dot on each day a
// payment comes up short. The forecast's day-by-day list is its table view.
export function ForecastChart({ days }: { days: ForecastDay[] }) {
  if (days.length < 2) return null;
  const shortDays = days.filter((d) => d.events.some((e) => e.shortCents > 0)).length;
  const lowest = days.reduce((m, d) => (d.balanceCents < m.balanceCents ? d : m), days[0]);
  const summary =
    `Projected cash from ${shortDateLabel(days[0].date)} to ${shortDateLabel(days[days.length - 1].date)}: ` +
    `starts at ${fmtMoney(days[0].balanceCents)}, lowest ${fmtMoney(lowest.balanceCents)} on ${shortDateLabel(lowest.date)}, ` +
    `ends at ${fmtMoney(days[days.length - 1].balanceCents)}` +
    (shortDays ? `; short on ${shortDays} day${shortDays === 1 ? '' : 's'}.` : '.');

  return (
    <StepChart
      ariaLabel={summary}
      points={days.map((d) => ({
        date: d.date,
        valueCents: d.balanceCents,
        alert: d.events.some((e) => e.shortCents > 0),
        tip: d.events.map((e) => ({
          amount: `${e.kind === 'in' ? '+' : '−'}${fmtMoney(e.amountCents)}`,
          text: e.item.name,
          alert: e.shortCents > 0 ? `short ${fmtMoney(e.shortCents)}` : undefined,
        })),
      }))}
    />
  );
}
