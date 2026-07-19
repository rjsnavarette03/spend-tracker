import { useRef } from 'react';
import { changeGranularity, periodLabel, periodOf, shiftPeriod, todayStr } from '../format';
import type { Granularity, Period } from '../format';
import { ChevronLeftIcon, ChevronRightIcon } from './Icons';

const GRANULARITIES: Array<{ g: Granularity; label: string }> = [
  { g: 'day', label: 'Day' },
  { g: 'week', label: 'Week' },
  { g: 'month', label: 'Month' },
  { g: 'year', label: 'Year' },
];

function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

// Day / Week / Month / Year selector with prev/next navigation AND a
// calendar picker. Clicking the label opens the native picker matched to the
// granularity (date for day/week, month for month); year uses a dropdown.
// Emits a Period ({granularity, start, end}) consumed by Dashboard/Transactions.
export function PeriodPicker({
  value,
  onChange,
  availableYears = [],
}: {
  value: Period;
  onChange: (p: Period) => void;
  // Years that have transactions; the year dropdown is limited to these (plus
  // the current year and whatever year is currently selected). Never future.
  availableYears?: number[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const openPicker = () => {
    const el = inputRef.current as (HTMLInputElement & { showPicker?: () => void }) | null;
    if (!el) return;
    // showPicker() (Chrome/Edge/FF/Safari 16+) pops the calendar without the
    // input being visible; fall back to focus for older browsers.
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {
        /* not allowed in this context — fall through */
      }
    }
    el.focus();
  };

  // Native input: date for day & week (week snaps to its Sunday–Saturday on
  // change), month input for month. Year uses a <select> (no native year picker).
  const nativeType = value.granularity === 'month' ? 'month' : 'date';
  const nativeValue = value.granularity === 'month' ? value.start.slice(0, 7) : value.start;

  const onNativeChange = (raw: string) => {
    if (!raw) return;
    if (value.granularity === 'month') {
      const [y, m] = raw.split('-').map(Number);
      onChange(periodOf('month', new Date(y, m - 1, 1)));
    } else {
      // day → that day; week → the Sunday–Saturday week containing the pick.
      onChange(periodOf(value.granularity, parseYmd(raw)));
    }
  };

  // Year options: only years with transactions, capped at the current year (no
  // future), always including the current year (so it's selectable) and the
  // currently-selected year (so the <select> stays consistent if the arrows
  // stepped onto an activity-free year).
  const selectedYear = Number(value.start.slice(0, 4));
  const thisYear = Number(todayStr().slice(0, 4));
  const yearSet = new Set<number>([thisYear]);
  for (const y of availableYears) if (y <= thisYear) yearSet.add(y);
  if (selectedYear <= thisYear) yearSet.add(selectedYear);
  const years = [...yearSet].sort((a, b) => b - a);
  // In year mode the current year is the max — don't let "next" reach a future year.
  const atMaxYear = value.granularity === 'year' && selectedYear >= thisYear;

  return (
    <div className="period-picker">
      <div className="segmented gran-segmented" role="group" aria-label="Period granularity">
        {GRANULARITIES.map(({ g, label }) => (
          <button
            key={g}
            type="button"
            className={value.granularity === g ? 'active-account' : ''}
            onClick={() => onChange(changeGranularity(value, g))}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="period-nav">
        <button
          className="btn-icon"
          onClick={() => onChange(shiftPeriod(value, -1))}
          title="Previous period"
        >
          <ChevronLeftIcon />
        </button>

        {value.granularity === 'year' ? (
          <select
            className="period-year"
            aria-label="Choose year"
            value={selectedYear}
            onChange={(e) => onChange(periodOf('year', new Date(Number(e.target.value), 0, 1)))}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        ) : (
          <span className="period-label-wrap">
            <button
              type="button"
              className="period-label period-label-btn"
              onClick={openPicker}
              title="Choose from calendar"
            >
              {periodLabel(value)}
            </button>
            <input
              ref={inputRef}
              className="period-native-input"
              type={nativeType}
              aria-label="Choose date"
              value={nativeValue}
              onChange={(e) => onNativeChange(e.target.value)}
              tabIndex={-1}
            />
          </span>
        )}

        <button
          className="btn-icon"
          onClick={() => onChange(shiftPeriod(value, 1))}
          title={atMaxYear ? 'Current year' : 'Next period'}
          disabled={atMaxYear}
        >
          <ChevronRightIcon />
        </button>
      </div>
    </div>
  );
}
