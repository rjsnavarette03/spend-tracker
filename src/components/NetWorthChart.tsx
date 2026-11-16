import { useEffect, useState } from 'react';
import type { NetWorthPoint } from '../../shared/types';
import { api } from '../api';
import { fmtMoney, monthLabel, todayStr } from '../format';
import { StepChart } from './StepChart';
import type { StepPoint } from './StepChart';

const RANGES: Array<[number, string]> = [
  [6, '6 months'],
  [12, '12 months'],
  [24, '2 years'],
  [60, '5 years'],
];
const RANGE_KEY = 'spendtracker-networth-months';

function savedRange(): number {
  try {
    const v = Number(localStorage.getItem(RANGE_KEY));
    if (RANGES.some(([n]) => n === v)) return v;
  } catch {
    /* storage unavailable: the default stands */
  }
  return 12;
}

/** 'Jul 2026' */
function shortMonthYear(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** The last day of a YYYY-MM month, or today for the month we're in. */
function pointDate(month: string, today: string): string {
  if (month === today.slice(0, 7)) return today;
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}

/**
 * Net worth at each month end, from the ledger (GET /reports/networth): the
 * Net Worth card above it, back in time. `version` changes whenever a
 * balance does, so the line follows edits made anywhere in the app.
 */
export function NetWorthChart({ version }: { version: string }) {
  const [months, setMonths] = useState(savedRange);
  const [points, setPoints] = useState<NetWorthPoint[] | null>(null);

  useEffect(() => {
    let stale = false;
    api.reports
      .netWorth(months)
      .then((p) => {
        if (!stale) setPoints(p);
      })
      .catch(() => {
        if (!stale) setPoints([]); // the card above still shows today's figure
      });
    return () => {
      stale = true;
    };
  }, [months, version]);

  if (points === null) return null;
  const today = todayStr();
  const chart: StepPoint[] = points.map((p) => ({
    date: pointDate(p.month, today),
    valueCents: p.netCents,
    tip: [
      { amount: fmtMoney(p.assetsCents), text: 'assets' },
      { amount: fmtMoney(p.liabilitiesCents), text: 'owed' },
    ],
  }));
  const first = points[0];
  const last = points[points.length - 1];
  const change = first && last ? last.netCents - first.netCents : 0;

  return (
    <div className="panel nw-panel">
      <div className="panel-head">
        <div className="panel-title">Net worth over time</div>
        <select
          aria-label="Net worth range"
          value={months}
          onChange={(e) => {
            const n = Number(e.target.value);
            setMonths(n);
            try {
              localStorage.setItem(RANGE_KEY, String(n));
            } catch {
              /* storage unavailable: applies for this visit */
            }
          }}
        >
          {RANGES.map(([n, label]) => (
            <option key={n} value={n}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {points.length < 2 ? (
        <div className="field-hint">
          Your history starts this month, so there's one point so far. The line grows as each month
          closes.
        </div>
      ) : (
        <>
          <div className="nw-change">
            <strong className={`num ${change < 0 ? 'amount-expense' : 'amount-income'}`}>
              {change < 0 ? 'Down ' : 'Up '}
              {fmtMoney(Math.abs(change))}
            </strong>{' '}
            since {monthLabel(first.month)}
            {last.liabilitiesCents !== first.liabilitiesCents && (
              <span className="sub-next-muted">
                {' · '}
                debt {last.liabilitiesCents < first.liabilitiesCents ? 'down' : 'up'}{' '}
                {fmtMoney(Math.abs(last.liabilitiesCents - first.liabilitiesCents))}
              </span>
            )}
          </div>
          <StepChart
            points={chart}
            line
            ariaLabel={`Net worth by month, ${monthLabel(first.month)} to now`}
            startLabel={shortMonthYear(first.month)}
            axisLabel={(date) => (date === today ? 'Now' : shortMonthYear(date.slice(0, 7)))}
            tipTitle={(p) => (p.date === today ? 'Now' : monthLabel(p.date.slice(0, 7)))}
          />
          <div className="field-hint">
            Each point is the end of a month, worked out from your transactions and transfers. An
            account counts from the month you added it or first used it.
          </div>
        </>
      )}
    </div>
  );
}
