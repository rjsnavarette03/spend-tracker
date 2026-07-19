import type { MonthlySummary } from '../../shared/types';
import { fmtMoney, shortMonthLabel } from '../format';

export function TrendChart({ data }: { data: MonthlySummary[] }) {
  const W = 600;
  const H = 240;
  const padTop = 14;
  const padBottom = 30;
  const plotH = H - padTop - padBottom;

  const max = Math.max(1, ...data.map((d) => Math.max(d.incomeCents, d.expenseCents)));
  const hasData = data.some((d) => d.incomeCents > 0 || d.expenseCents > 0);

  if (!hasData) {
    return <div className="empty-state">No activity yet — add transactions to see the trend.</div>;
  }

  const group = W / data.length;
  const barW = Math.min(26, group * 0.28);

  const summary = `Income vs expenses over ${data.length} months: ${data
    .map((d) => `${shortMonthLabel(d.month)} income ${fmtMoney(d.incomeCents)}, expenses ${fmtMoney(d.expenseCents)}`)
    .join('; ')}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      role="img"
      aria-label={summary}
    >
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line
          key={f}
          x1={0}
          x2={W}
          y1={padTop + plotH * (1 - f)}
          y2={padTop + plotH * (1 - f)}
          stroke="var(--surface-3)"
          strokeWidth={1}
        />
      ))}
      {data.map((d, i) => {
        const cx = i * group + group / 2;
        const ih = (d.incomeCents / max) * plotH;
        const eh = (d.expenseCents / max) * plotH;
        return (
          <g key={d.month}>
            <rect
              x={cx - barW - 2.5}
              y={padTop + plotH - ih}
              width={barW}
              height={Math.max(ih, d.incomeCents > 0 ? 2 : 0)}
              rx={3.5}
              fill="var(--green)"
            >
              <title>{`${shortMonthLabel(d.month)} income: ${fmtMoney(d.incomeCents)}`}</title>
            </rect>
            <rect
              x={cx + 2.5}
              y={padTop + plotH - eh}
              width={barW}
              height={Math.max(eh, d.expenseCents > 0 ? 2 : 0)}
              rx={3.5}
              fill="var(--red)"
            >
              <title>{`${shortMonthLabel(d.month)} expenses: ${fmtMoney(d.expenseCents)}`}</title>
            </rect>
            <text x={cx} y={H - 9} textAnchor="middle" className="chart-label">
              {shortMonthLabel(d.month)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
