import { addMonths } from '../format';
import { ChevronLeftIcon, ChevronRightIcon } from './Icons';

export function MonthPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (month: string) => void;
}) {
  return (
    <div className="month-picker">
      <button className="btn-icon" onClick={() => onChange(addMonths(value, -1))} title="Previous month">
        <ChevronLeftIcon />
      </button>
      <input
        type="month"
        value={value}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
      />
      <button className="btn-icon" onClick={() => onChange(addMonths(value, 1))} title="Next month">
        <ChevronRightIcon />
      </button>
    </div>
  );
}
