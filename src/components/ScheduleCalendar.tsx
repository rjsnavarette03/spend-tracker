import { useEffect, useState } from 'react';
import { currentMonth, fmtMoney } from '../format';
import { shortDateLabel } from '../schedule';
import type { CalendarDay, CalendarState, ItemOccurrence, PaydayOccurrence } from '../schedule';
import { MonthPicker } from './MonthPicker';
import { PaydayLine, PlanLine } from './PlanLine';

// The Schedule's month view: paydays and due dates on a Sunday-first grid.
// Each due date is a chip whose state shows as a symbol AND a color (never
// color alone); phones get colored dots instead of names, and the selected
// day's details (with Mark as paid / Log received) are listed under the grid.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const STATE: Record<CalendarState, { symbol: string; label: string }> = {
  paid: { symbol: '✓', label: 'Paid' },
  upcoming: { symbol: '', label: 'Upcoming' },
  atrisk: { symbol: '⚠', label: 'At risk' },
  overdue: { symbol: '!', label: 'Overdue' },
  past: { symbol: '', label: 'Past' },
  auto: { symbol: '↻', label: 'Auto-charged' },
};

const LEGEND: CalendarState[] = ['paid', 'upcoming', 'atrisk', 'overdue'];

// Chips per cell before "+N more" (paydays count toward it).
const MAX_CHIPS = 3;

function dayLabel(d: CalendarDay): string {
  const parts = [shortDateLabel(d.date)];
  if (d.paydays.length) parts.push('payday');
  if (d.entries.length) parts.push(`${d.entries.length} due`);
  for (const state of ['overdue', 'atrisk'] as const) {
    const n = d.entries.filter((e) => e.state === state).length;
    if (n) parts.push(`${n} ${STATE[state].label.toLowerCase()}`);
  }
  return parts.join(', ');
}

export function ScheduleCalendar({
  month,
  onMonthChange,
  days,
  today,
  onPay,
  onLog,
}: {
  month: string; // 'YYYY-MM'
  onMonthChange: (month: string) => void;
  days: CalendarDay[];
  today: string;
  onPay: (occurrence: ItemOccurrence) => void;
  onLog: (payday: PaydayOccurrence) => void;
}) {
  const startOf = (m: string) => (today.slice(0, 7) === m ? today : `${m}-01`);
  const [selected, setSelected] = useState(startOf(month));
  useEffect(() => {
    setSelected(startOf(month));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the month changes
  }, [month]);
  const day = days.find((d) => d.date === selected);

  return (
    <>
      <div className="panel">
        <div className="cal-toolbar">
          <div className="cal-nav">
            <MonthPicker value={month} onChange={onMonthChange} />
            {month !== currentMonth() && (
              <button className="btn" onClick={() => onMonthChange(currentMonth())}>
                This month
              </button>
            )}
          </div>
          <div className="cal-legend" aria-label="Legend">
            <span className="cal-chip cal-chip-payday">◆ Payday</span>
            {LEGEND.map((s) => (
              <span key={s} className={`cal-chip cal-chip-${s}`}>
                {STATE[s].symbol && `${STATE[s].symbol} `}
                {STATE[s].label}
              </span>
            ))}
          </div>
        </div>

        <div className="cal-grid">
          {WEEKDAYS.map((w) => (
            <div key={w} className="cal-weekday" aria-hidden="true">
              {w}
            </div>
          ))}
          {days.map((d) => {
            const shown = Math.max(0, MAX_CHIPS - d.paydays.length);
            const more = d.entries.length - shown;
            return (
              <button
                key={d.date}
                type="button"
                className={[
                  'cal-day',
                  d.inMonth ? '' : 'cal-out',
                  d.date === today ? 'cal-today' : '',
                  d.date === selected ? 'cal-selected' : '',
                ].join(' ')}
                aria-pressed={d.date === selected}
                aria-label={dayLabel(d)}
                onClick={() => setSelected(d.date)}
              >
                <span className="cal-num">{Number(d.date.slice(8))}</span>
                {d.paydays.map((p) => (
                  <span
                    key={p.payday.item.id}
                    className={`cal-chip cal-chip-payday ${p.status.state === 'received' ? 'cal-chip-paid' : ''}`}
                    title={`${p.payday.item.name} — ${fmtMoney(p.payday.item.amountCents)} expected`}
                  >
                    ◆ {p.payday.item.name}
                  </span>
                ))}
                {d.entries.slice(0, shown).map((e) => (
                  <span
                    key={e.occurrence.item.id}
                    className={`cal-chip cal-chip-${e.state}`}
                    title={`${e.occurrence.item.name} — ${STATE[e.state].label}, ${fmtMoney(e.occurrence.amountCents)}`}
                  >
                    {STATE[e.state].symbol && `${STATE[e.state].symbol} `}
                    {e.occurrence.item.name}
                  </span>
                ))}
                {more > 0 && <span className="cal-more">+{more} more</span>}
                <span className="cal-dots" aria-hidden="true">
                  {d.paydays.map((p) => (
                    <span key={`p${p.payday.item.id}`} className="cal-dot cal-dot-payday" />
                  ))}
                  {d.entries.map((e) => (
                    <span key={e.occurrence.item.id} className={`cal-dot cal-dot-${e.state}`} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="panel mt-panel">
        <div className="panel-title">{shortDateLabel(selected)}</div>
        {!day || (day.paydays.length === 0 && day.entries.length === 0) ? (
          <div className="field-hint">Nothing comes in or is due on this day.</div>
        ) : (
          <div className="plan-lines">
            {day.paydays.map((p) => (
              <PaydayLine key={`p${p.payday.item.id}`} payday={p.payday} status={p.status} onLog={() => onLog(p.payday)} />
            ))}
            {day.entries.map((e) => (
              <PlanLine
                key={e.occurrence.item.id}
                occurrence={e.occurrence}
                status={e.status}
                shortCents={e.shortCents}
                onPay={() => onPay(e.occurrence)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
