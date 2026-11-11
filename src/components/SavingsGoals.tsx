import { useMemo } from 'react';
import type { ScheduleData, ScheduleItem } from '../../shared/types';
import { compactMoney, dateLabel, fmtMoney, ordinal } from '../format';
import { buildGoals } from '../schedule';
import type { GoalCheckpoint, GoalProgress, ScheduleContext } from '../schedule';
import { PencilIcon, PlusIcon } from './Icons';

// Savings goals on the Schedule's Progress tab: how much each goal's account
// holds against its milestones and goal, and roughly when the scheduled
// contributions get to the next one. Saved = the account's live balance, so
// any deposit into it (through the Schedule or not) moves the bar.

/** "Feb 2027" — estimates are a month-level promise, not a day. */
function monthYear(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function chipLabel(c: GoalCheckpoint): string {
  const amount = `${c.isGoal ? 'Goal ' : ''}${compactMoney(c.cents)}`;
  if (c.reached) return `✓ ${amount}`;
  return c.eta ? `${amount} · ${monthYear(c.eta)}` : amount;
}

function contribution(g: GoalProgress): string {
  const { item } = g;
  if (!item.active) return 'Paused — no contributions scheduled';
  const parts = [
    item.dueDay != null ? `${fmtMoney(item.amountCents)} monthly on the ${ordinal(item.dueDay)}` : fmtMoney(item.amountCents),
  ];
  if (g.account) parts.push(`into ${g.account.name}`);
  if (item.endDate) parts.push(`until ${dateLabel(item.endDate)}`);
  return parts.join(' · ');
}

function nextLine(g: GoalProgress): { text: string; done: boolean } {
  if (g.checkpoints.length === 0) return { text: 'No goal set yet — edit it to add a goal and milestones.', done: false };
  if (!g.next) return { text: `Goal of ${fmtMoney(g.checkpoints[g.checkpoints.length - 1].cents)} reached.`, done: true };
  const n = g.next;
  const toGo = `${fmtMoney(n.cents - g.savedCents)} to go`;
  const what = n.isGoal ? `the ${fmtMoney(n.cents)} goal` : `${fmtMoney(n.cents)}`;
  if (n.eta) return { text: `Next: ${what} around ${dateLabel(n.eta)} — ${toGo}.`, done: false };
  return {
    text: g.item.active
      ? `Next: ${what} — ${toGo}. The scheduled contributions don't get there.`
      : `Next: ${what} — ${toGo}.`,
    done: false,
  };
}

function GoalBar({ g }: { g: GoalProgress }) {
  const top = g.checkpoints[g.checkpoints.length - 1]?.cents ?? 0;
  if (top <= 0) return null;
  const pct = Math.min(100, (g.savedCents / top) * 100);
  return (
    <div
      className="progress goal-bar"
      role="progressbar"
      aria-label={`${g.item.name}: ${fmtMoney(g.savedCents)} of ${fmtMoney(top)}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div className="progress-fill ok" style={{ width: `${pct}%` }} />
      {g.checkpoints
        .filter((c) => c.cents < top)
        .map((c) => (
          <span
            key={c.cents}
            className={`goal-tick${c.reached ? ' goal-tick-reached' : ''}`}
            style={{ left: `${(c.cents / top) * 100}%` }}
          />
        ))}
    </div>
  );
}

export function SavingsGoals({
  items,
  data,
  ctx,
  today,
  onAdd,
  onEdit,
}: {
  items: ScheduleItem[];
  data: ScheduleData;
  ctx: ScheduleContext;
  today: string;
  onAdd: () => void;
  onEdit: (item: ScheduleItem) => void;
}) {
  const goals = useMemo(() => buildGoals(items, data, ctx, today), [items, data, ctx, today]);

  return (
    <div className="panel mt-panel">
      <div className="panel-head">
        <div className="panel-title">Savings goals</div>
        <button className="btn" onClick={onAdd}>
          <PlusIcon /> Add goal
        </button>
      </div>
      {goals.length === 0 && (
        <div className="field-hint">
          No savings goals yet. Add one — an emergency fund, a house or a car — with milestones along the way, and
          see when your scheduled savings reach each one.
        </div>
      )}
      {goals.map((g) => {
        const top = g.checkpoints[g.checkpoints.length - 1]?.cents ?? null;
        const pct = top ? Math.floor(Math.min(100, (g.savedCents / top) * 100)) : null;
        const next = nextLine(g);
        return (
          <div className="goal" key={g.item.id}>
            <div className="goal-head sched-rule">
              <div className="sub-main">
                <div className="sub-name">
                  {g.item.name}
                  {!g.item.active && <span className="type-tag sub-tag">Paused</span>}
                </div>
                <div className="sub-meta">{contribution(g)}</div>
              </div>
              <div className="sub-right">
                <span className="sub-amount num">{fmtMoney(g.savedCents)}</span>
                <span className="sub-next-muted">{top ? `of ${fmtMoney(top)} · ${pct}%` : 'saved'}</span>
              </div>
              <div className="sub-actions">
                <button className="btn-icon" title="Edit goal" aria-label={`Edit ${g.item.name}`} onClick={() => onEdit(g.item)}>
                  <PencilIcon />
                </button>
              </div>
            </div>
            <GoalBar g={g} />
            {g.checkpoints.length > 0 && (
              <div className="goal-chips">
                {g.checkpoints.map((c) => (
                  <span
                    key={c.cents}
                    className={`due-tag${c.reached ? ' due-ok' : c === g.next ? ' goal-next' : ''}`}
                    title={
                      c.reached
                        ? `${fmtMoney(c.cents)} reached`
                        : c.eta
                          ? `${fmtMoney(c.cents)} around ${dateLabel(c.eta)}`
                          : `${fmtMoney(c.cents)} — not reached on this schedule`
                    }
                  >
                    {chipLabel(c)}
                  </span>
                ))}
              </div>
            )}
            <div className={`goal-next-line${next.done ? ' amount-income' : ''}`}>{next.text}</div>
            {!g.account && (
              <div className="field-hint">Its account was deleted, so there's no balance to track — edit it to pick one.</div>
            )}
            {g.sharedWith.length > 0 && (
              <div className="field-hint">
                {g.account?.name} also holds {g.sharedWith.join(', ')} — its whole balance counts toward each goal.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
