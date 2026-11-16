import { creditUsage, fmtMoney } from '../format';
import { ProgressBar } from './ProgressBar';

// How much of a credit card's limit is in use: a bar (amber from 75%, red at
// the limit) and the figures. `compact` is the one-line version for the
// accounts list; the full one adds what's still available.
export function CreditUsage({
  balanceCents,
  limitCents,
  compact = false,
}: {
  balanceCents: number;
  limitCents: number;
  compact?: boolean;
}) {
  const { availableCents, pct } = creditUsage(balanceCents, limitCents);
  return (
    <div className={`credit-usage ${compact ? 'credit-usage-compact' : ''}`}>
      <ProgressBar pct={pct} />
      <span className="credit-usage-text">
        {pct}% of {fmtMoney(limitCents)} used
        {!compact &&
          (availableCents >= 0
            ? ` · ${fmtMoney(availableCents)} available`
            : ` · over the limit by ${fmtMoney(-availableCents)}`)}
      </span>
    </div>
  );
}
