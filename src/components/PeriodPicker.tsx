import { changeGranularity, periodLabel, shiftPeriod } from '../format';
import type { Granularity, Period } from '../format';
import { ChevronLeftIcon, ChevronRightIcon } from './Icons';

const GRANULARITIES: Array<{ g: Granularity; label: string }> = [
  { g: 'day', label: 'Day' },
  { g: 'week', label: 'Week' },
  { g: 'month', label: 'Month' },
  { g: 'year', label: 'Year' },
];

// Day / Week / Month / Year selector with prev/next navigation. Emits a Period
// ({granularity, start, end}) consumed by the Dashboard and Transactions.
export function PeriodPicker({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  return (
    <div className="period-picker">
      <div className="segmented gran-segmented">
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
        <span className="period-label">{periodLabel(value)}</span>
        <button
          className="btn-icon"
          onClick={() => onChange(shiftPeriod(value, 1))}
          title="Next period"
        >
          <ChevronRightIcon />
        </button>
      </div>
    </div>
  );
}
