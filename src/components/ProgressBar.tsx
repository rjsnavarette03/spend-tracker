export function ProgressBar({ pct }: { pct: number }) {
  const cls = pct >= 100 ? 'over' : pct >= 75 ? 'warn' : 'ok';
  return (
    <div className="progress">
      <div className={`progress-fill ${cls}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}
