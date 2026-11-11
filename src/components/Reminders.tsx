import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Account, Category, ScheduleData, Subscription } from '../../shared/types';
import { api } from '../api';
import { todayStr } from '../format';
import { addDays, buildForecast, buildReminders, occurrenceKey, REMIND_DAYS, withSubscriptions } from '../schedule';
import type { PaydayOccurrence, Reminder, ReminderStage } from '../schedule';
import { BellIcon } from './Icons';
import { LogReceivedModal } from './LogReceivedModal';
import { MarkPaidModal } from './MarkPaidModal';
import { Modal } from './Modal';
import { PaydayLine, PlanLine } from './PlanLine';

// In-app reminders: a bell in the app chrome whose badge counts reminders not
// seen yet, and a panel listing every current one with Mark as paid / Log
// received. What's due is worked out from the Schedule (buildReminders), so a
// reminder clears itself once paid — however it was paid. "Seen" lives in
// this browser only (localStorage, per user): opening the panel marks what's
// listed as seen, and a reminder comes back when it reaches its due date and
// again if it passes unpaid.

const SEEN_KEY = 'spendtracker-reminders-seen';
// Seen keys for due dates older than this are dropped; nothing that old is reminded.
const SEEN_KEEP_DAYS = 90;

function readSeen(userId: number): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`${SEEN_KEY}:${userId}`) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeSeen(userId: number, keys: Set<string>): void {
  try {
    localStorage.setItem(`${SEEN_KEY}:${userId}`, JSON.stringify([...keys]));
  } catch {
    /* storage unavailable — the badge just resets next visit */
  }
}

export interface RemindersState {
  reminders: Reminder[];
  shortBy: Map<string, number>; // forecast shortfalls, to flag a reminder that money won't cover
  unseen: number;
  markSeen: () => void;
}

/**
 * Loads the Schedule for the reminders and keeps it fresh: again after any
 * change in the app (dataVersion) and when the tab comes back into view — a
 * new day, or salary logged on another device.
 */
export function useReminders(userId: number, accounts: Account[], dataVersion: number): RemindersState {
  const [data, setData] = useState<ScheduleData | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [today, setToday] = useState(todayStr());
  const [seen, setSeen] = useState<Set<string>>(() => readSeen(userId));

  const load = useCallback(async () => {
    try {
      const [schedule, subs] = await Promise.all([api.schedule.get(), api.subscriptions.list()]);
      setData(schedule);
      setSubscriptions(subs);
      setToday(todayStr());
    } catch {
      // non-fatal: the bell keeps what it last showed
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const items = useMemo(() => (data ? withSubscriptions(data.items, subscriptions) : []), [data, subscriptions]);
  const ctx = useMemo(() => ({ accounts, subscriptions }), [accounts, subscriptions]);
  const reminders = useMemo(() => (data ? buildReminders(items, data, ctx, today) : []), [items, data, ctx, today]);
  const shortBy = useMemo(
    () => (data ? buildForecast(items, data, ctx, today).shortBy : new Map<string, number>()),
    [items, data, ctx, today]
  );

  const markSeen = useCallback(() => {
    const oldest = addDays(today, -SEEN_KEEP_DAYS);
    // Keys end in the due date ('stage|itemId|YYYY-MM-DD').
    const next = new Set([...seen].filter((k) => (k.split('|').pop() ?? '') >= oldest));
    for (const r of reminders) next.add(r.key);
    if (next.size === seen.size && [...next].every((k) => seen.has(k))) return;
    setSeen(next);
    writeSeen(userId, next);
  }, [seen, reminders, today, userId]);

  const unseen = reminders.filter((r) => !seen.has(r.key)).length;
  return { reminders, shortBy, unseen, markSeen };
}

export function ReminderBell({ unseen, onClick }: { unseen: number; onClick: () => void }) {
  const label = unseen > 0 ? `Reminders, ${unseen} new` : 'Reminders';
  return (
    <button className="btn-icon bell-btn" onClick={onClick} title={label} aria-label={label}>
      <BellIcon />
      {unseen > 0 && (
        <span className="bell-badge" aria-hidden="true">
          {unseen > 9 ? '9+' : unseen}
        </span>
      )}
    </button>
  );
}

const GROUPS: Array<[ReminderStage, string]> = [
  ['overdue', 'Overdue'],
  ['unlogged', 'Salary not logged yet'],
  ['today', 'Today'],
  ['soon', `Next ${REMIND_DAYS} days`],
];

/**
 * The reminders list. Mark as paid / Log received swap the list for that
 * form (one dialog at a time) and come back to the list when it closes.
 */
export function RemindersPanel({
  state,
  accounts,
  categories,
  onClose,
  onSaved,
  onPlanner,
}: {
  state: RemindersState;
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
  onPlanner: () => void;
}) {
  const { reminders, shortBy, markSeen } = state;
  const [paying, setPaying] = useState<Extract<Reminder, { kind: 'due' }> | null>(null);
  const [logging, setLogging] = useState<PaydayOccurrence | null>(null);

  // Anything that shows up while the list is open counts as seen too.
  useEffect(() => {
    markSeen();
  }, [markSeen]);

  if (paying) {
    return (
      <MarkPaidModal
        occurrence={paying.occurrence}
        status={paying.status}
        accounts={accounts}
        categories={categories}
        onClose={() => setPaying(null)}
        onSaved={onSaved}
      />
    );
  }
  if (logging) {
    return (
      <LogReceivedModal occurrence={logging} accounts={accounts} onClose={() => setLogging(null)} onSaved={onSaved} />
    );
  }

  return (
    <Modal title="Reminders" onClose={onClose}>
      <div className="form-grid">
        {reminders.length === 0 ? (
          <div className="field-hint">
            You're all caught up. Reminders show up here {REMIND_DAYS} days before each due date and on paydays.
          </div>
        ) : (
          GROUPS.map(([stage, title]) => {
            const list = reminders.filter((r) => r.stage === stage);
            if (list.length === 0) return null;
            return (
              <div key={stage} className="reminder-group">
                <div className="sched-group-title">{title}</div>
                <div className="plan-lines">
                  {list.map((r) =>
                    r.kind === 'due' ? (
                      <PlanLine
                        key={r.key}
                        occurrence={r.occurrence}
                        status={r.status}
                        shortCents={shortBy.get(occurrenceKey(r.occurrence.item.id, r.occurrence.dueDate)) ?? 0}
                        onPay={() => setPaying(r)}
                      />
                    ) : (
                      <PaydayLine key={r.key} payday={r.payday} status={r.status} onLog={() => setLogging(r.payday)} />
                    )
                  )}
                </div>
              </div>
            );
          })
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onPlanner}>
            Open the planner
          </button>
        </div>
      </div>
    </Modal>
  );
}
