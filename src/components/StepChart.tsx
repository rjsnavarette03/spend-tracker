import { KeyboardEvent, PointerEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { compactMoney, fmtMoney } from '../format';
import { daysBetween, parseYmd, shortDateLabel } from '../schedule';

// A money value over time as a step line (it only moves when money moves):
// a faint wash above zero, a red wash below it, red dots on flagged points,
// and a crosshair + tooltip that snaps to the nearest point — also by
// keyboard (←/→ once focused). X is proportional to time, so it works for
// daily points (cash forecast) and sparse ones (debt payments months apart).
// The drawing is sized to its container in real pixels (1 unit = 1px) so the
// 11px axis text stays 11px on a phone.

export interface StepPoint {
  date: string; // YYYY-MM-DD
  valueCents: number;
  alert?: boolean; // red dot
  tip: Array<{ amount: string; text: string; alert?: string }>;
}

const H = 220;
const PAD_L = 60;
const PAD_R = 14;
const PAD_T = 12;
const PAD_B = 26;
const PLOT_H = H - PAD_T - PAD_B;
const TIP_LINES = 4;

/** 1, 2 or 5 × a power of ten — round gridline spacing. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function StepChart({
  points,
  ariaLabel,
  startLabel = 'Today',
}: {
  points: StepPoint[];
  ariaLabel: string;
  startLabel?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (points.length < 2) return null;

  const W = Math.max(280, width);
  const PLOT_W = W - PAD_L - PAD_R;
  const first = points[0].date;
  const span = Math.max(1, daysBetween(first, points[points.length - 1].date));

  const values = points.map((p) => p.valueCents);
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (hi === lo) hi = lo + 100000;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);

  const xAt = (date: string) => PAD_L + (daysBetween(first, date) / span) * PLOT_W;
  const x = (i: number) => xAt(points[i].date);
  const y = (v: number) => PAD_T + ((hi - v) / (hi - lo)) * PLOT_H;
  const zeroY = y(0);

  let line = `M ${x(0)} ${y(values[0])}`;
  for (let i = 1; i < points.length; i++) line += ` H ${x(i)} V ${y(values[i])}`;
  const area = `${line} V ${zeroY} H ${x(0)} Z`;

  // Evenly spaced date labels, about one per 70px, first and last pinned.
  const labelCount = Math.max(2, Math.min(5, Math.floor(PLOT_W / 70)));
  const long = span > 120;
  const labelFor = (date: string) =>
    parseYmd(date).toLocaleDateString('en-US', long ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' });
  const labels = Array.from({ length: labelCount }, (_, k) => {
    const days = Math.round((k * span) / (labelCount - 1));
    const d = parseYmd(first);
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
    const ymd = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { x: PAD_L + (days / span) * PLOT_W, text: k === 0 ? startLabel : labelFor(ymd), k };
  });

  const nearest = (px: number) => {
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    return best;
  };
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setActive(nearest(((e.clientX - rect.left) * W) / rect.width));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setActive((i) => Math.min(points.length - 1, Math.max(0, (i ?? 0) + (e.key === 'ArrowRight' ? 1 : -1))));
  };

  const point = active === null ? null : points[active];
  const ratio = active === null ? 0 : x(active) / W;
  const align = ratio > 0.7 ? 'right' : ratio < 0.3 ? 'left' : 'center';

  return (
    <div className="fc-chart" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((i) => i ?? 0)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        <defs>
          <clipPath id={`above-${uid}`}>
            <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={Math.max(0, zeroY - PAD_T)} />
          </clipPath>
          <clipPath id={`below-${uid}`}>
            <rect x={PAD_L} y={zeroY} width={PLOT_W} height={Math.max(0, PAD_T + PLOT_H - zeroY)} />
          </clipPath>
        </defs>

        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(v)}
              y2={y(v)}
              stroke={v === 0 ? 'var(--border-strong)' : 'var(--surface-3)'}
              strokeWidth={1}
            />
            <text x={PAD_L - 8} y={y(v) + 4} textAnchor="end" className="chart-label">
              {compactMoney(v)}
            </text>
          </g>
        ))}
        {labels.map((l) => (
          <text
            key={l.k}
            x={l.x}
            y={H - 8}
            // The end labels hug the plot edges instead of hanging off them.
            textAnchor={l.k === 0 ? 'start' : l.k === labelCount - 1 ? 'end' : 'middle'}
            className="chart-label"
          >
            {l.text}
          </text>
        ))}

        <path d={area} fill="var(--accent)" fillOpacity={0.1} clipPath={`url(#above-${uid})`} />
        <path d={area} fill="var(--red)" fillOpacity={0.14} clipPath={`url(#below-${uid})`} />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {points.map((p, i) =>
          p.alert ? (
            <circle key={`${p.date}-${i}`} cx={x(i)} cy={y(p.valueCents)} r={4.5} fill="var(--red)" stroke="var(--surface)" strokeWidth={2} />
          ) : null
        )}

        {active !== null && point && (
          <g pointerEvents="none">
            <line x1={x(active)} x2={x(active)} y1={PAD_T} y2={PAD_T + PLOT_H} stroke="var(--text-faint)" strokeWidth={1} />
            <circle cx={x(active)} cy={y(point.valueCents)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>

      {point && (
        <div className={`fc-tooltip fc-tooltip-${align}`} style={{ left: `${ratio * 100}%` }} role="status">
          <div className="fc-tooltip-date">{shortDateLabel(point.date)}</div>
          <div className={`fc-tooltip-value num ${point.valueCents < 0 ? 'amount-expense' : ''}`}>
            {fmtMoney(point.valueCents)}
          </div>
          {point.tip.slice(0, TIP_LINES).map((t, idx) => (
            <div key={idx} className="fc-tooltip-row">
              <span className="num">{t.amount}</span>
              <span>
                {t.text}
                {t.alert && <strong className="amount-expense"> · {t.alert}</strong>}
              </span>
            </div>
          ))}
          {point.tip.length > TIP_LINES && <div className="fc-tooltip-row">+{point.tip.length - TIP_LINES} more</div>}
        </div>
      )}
    </div>
  );
}
