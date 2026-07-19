import type { BreakdownRow } from '../../shared/types';
import { fmtMoney } from '../format';

export function DonutChart({ rows }: { rows: BreakdownRow[] }) {
  const total = rows.reduce((sum, r) => sum + r.totalCents, 0);

  if (total <= 0) {
    return <div className="empty-state">No expenses recorded this month.</div>;
  }

  const R = 62;
  const C = 2 * Math.PI * R;
  let acc = 0;

  const summary = `Spending by category, total ${fmtMoney(total)}: ${rows
    .map((r) => `${r.name} ${Math.round((r.totalCents / total) * 100)}%`)
    .join(', ')}`;

  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 180 180" role="img" aria-label={summary}>
        <circle cx={90} cy={90} r={R} fill="none" stroke="var(--surface-3)" strokeWidth={26} />
        {rows.map((r) => {
          const frac = r.totalCents / total;
          const el = (
            <circle
              key={String(r.categoryId)}
              cx={90}
              cy={90}
              r={R}
              fill="none"
              stroke={r.color}
              strokeWidth={26}
              strokeDasharray={`${Math.max(frac * C - 1.5, 0.01)} ${C}`}
              strokeDashoffset={-acc * C}
              transform="rotate(-90 90 90)"
            >
              <title>{`${r.name}: ${fmtMoney(r.totalCents)}`}</title>
            </circle>
          );
          acc += frac;
          return el;
        })}
        <text x={90} y={87} textAnchor="middle" className="donut-total">
          {fmtMoney(total)}
        </text>
        <text x={90} y={105} textAnchor="middle" className="donut-sub">
          spent
        </text>
      </svg>
      <div className="donut-legend">
        {rows.map((r) => (
          <div className="donut-legend-row" key={String(r.categoryId)}>
            <span className="color-dot" style={{ background: r.color }} />
            <span className="name">{r.name}</span>
            <span className="amt">{fmtMoney(r.totalCents)}</span>
            <span className="pct">{Math.round((r.totalCents / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
