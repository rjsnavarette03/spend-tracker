import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  Account,
  Category,
  ScheduleData,
  ScheduleItem,
  ScheduleItemInput,
  ScheduleKind,
  Subscription,
  WeekendShift,
} from '../../shared/types';
import { isArchived } from '../accounts';
import { api } from '../api';
import { useAppContext } from '../App';
import { DebtPayoff } from '../components/DebtPayoff';
import { confirm, toast } from '../components/feedback';
import { ForecastChart } from '../components/ForecastChart';
import { BanknoteIcon, CheckIcon, PencilIcon, PlusIcon, TrashIcon } from '../components/Icons';
import { LogReceivedModal } from '../components/LogReceivedModal';
import { MarkPaidModal } from '../components/MarkPaidModal';
import { Modal } from '../components/Modal';
import { MoneyInput } from '../components/MoneyInput';
import { PlanLine } from '../components/PlanLine';
import { ProgressBar } from '../components/ProgressBar';
import { SavingsGoals } from '../components/SavingsGoals';
import { ScheduleCalendar } from '../components/ScheduleCalendar';
import { ScheduleItemModal } from '../components/ScheduleItemModal';
import type { OutflowKind } from '../components/ScheduleItemModal';
import { centsToInput, cleanError, currentMonth, fmtMoney, ordinal, parseAmountToCents, todayStr } from '../format';
import {
  addDays,
  allPaydayOccurrences,
  buildCalendar,
  buildForecast,
  buildPlanner,
  FORECAST_DAYS,
  chargedToCard,
  daysBetween,
  fundingPayday,
  itemOccurrences,
  KIND_LABEL,
  monthlyCents,
  monthlyDueDays,
  occurrenceAmount,
  occurrenceKey,
  remainingCount,
  shortDateLabel,
  toInput,
  WEEKDAY_LABEL,
  WEEKEND_RULE_LABEL,
  withSubscriptions,
} from '../schedule';
import type {
  DueStatus,
  Forecast,
  ForecastEvent,
  ItemOccurrence,
  PaydayOccurrence,
  PaydayPlan,
  PaydayStatus,
  Planner,
  ScheduleContext,
} from '../schedule';

// Paydays shown ahead of the current one; "Show more" adds two at a time.
const PLAN_AHEAD = 3;

type View = 'planner' | 'forecast' | 'calendar' | 'progress' | 'setup';
const VIEWS: Array<[View, string]> = [
  ['planner', 'Planner'],
  ['forecast', 'Forecast'],
  ['calendar', 'Calendar'],
  ['progress', 'Progress'],
  ['setup', 'Setup'],
];

const ITEM_GROUPS: Array<{ title: string; kinds: ScheduleKind[] }> = [
  { title: 'Loans & cards', kinds: ['loan', 'card'] },
  { title: 'Bills', kinds: ['bill'] },
  { title: 'Allowances', kinds: ['allowance'] },
  { title: 'Savings', kinds: ['savings'] },
  { title: 'Subscriptions', kinds: ['subscription'] },
];

function subscriptionCycle(sub: Subscription): string {
  if (sub.cycle === 'monthly') return `Monthly on the ${ordinal(sub.billDay ?? 1)}`;
  if (sub.cycle === 'yearly') return 'Yearly';
  return `Every ${sub.intervalDays} days`;
}

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1);

function weekendNote(rule: WeekendShift): string | null {
  if (rule === 'before') return 'Friday before on weekends';
  if (rule === 'after') return 'Monday after on weekends';
  return null;
}

function statusTag(status: PaydayStatus, date: string, today: string): { label: string; cls: string } {
  if (status.state === 'received') return { label: 'Received', cls: 'due-ok' };
  if (status.state === 'today') return { label: 'Today', cls: 'due-soon' };
  if (status.state === 'unlogged') return { label: 'Not logged', cls: 'due-soon' };
  const days = daysBetween(today, date);
  return { label: days === 1 ? 'Tomorrow' : `In ${days} days`, cls: '' };
}

export function Schedule() {
  const { accounts, categories, onDataChanged, dataVersion } = useAppContext();
  const [data, setData] = useState<ScheduleData | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [paydayModal, setPaydayModal] = useState<{ open: boolean; editing: ScheduleItem | null }>({
    open: false,
    editing: null,
  });
  const [itemModal, setItemModal] = useState<{
    open: boolean;
    editing: ScheduleItem | null;
    preset: { kind: OutflowKind; accountId?: number } | null;
  }>({ open: false, editing: null, preset: null });
  const [funding, setFunding] = useState<ScheduleItem | null>(null);
  const [logging, setLogging] = useState<PaydayOccurrence | null>(null);
  const [paying, setPaying] = useState<ItemOccurrence | null>(null);
  const [ahead, setAhead] = useState(PLAN_AHEAD);
  // The view lives in the URL (?view=…) so it survives reloads and Back.
  const [params, setParams] = useSearchParams();
  const requested = params.get('view');
  const view: View = VIEWS.find(([v]) => v === requested)?.[0] ?? 'planner';
  const [calMonth, setCalMonth] = useState(currentMonth());
  const setView = (v: View) => setParams(v === 'planner' ? {} : { view: v }, { replace: true });

  const load = useCallback(async () => {
    try {
      const [schedule, subs] = await Promise.all([api.schedule.get(), api.subscriptions.list()]);
      setData(schedule);
      setSubscriptions(subs);
    } catch (err) {
      toast.error(cleanError(err));
    }
  }, []);

  // Reloads after any change anywhere in the app (dataVersion) — including a
  // payment made from the reminders while this page is open.
  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  // Logging salary adds a transaction, so balances change too; onDataChanged
  // refreshes those and, through dataVersion, this page.
  const afterMutation = () => onDataChanged();

  const today = todayStr();
  const paydays = useMemo(() => (data?.items ?? []).filter((i) => i.kind === 'income'), [data]);
  // Each payday's next date, for the Setup list.
  const occurrences = useMemo(
    () => allPaydayOccurrences(paydays, today, addDays(today, 45)),
    [paydays, today]
  );
  const incomeMonthly = paydays.filter((p) => p.active).reduce((s, p) => s + p.amountCents, 0);

  const ctx: ScheduleContext = useMemo(() => ({ accounts, subscriptions }), [accounts, subscriptions]);
  const outflows = useMemo(
    () => withSubscriptions(data?.items ?? [], subscriptions).filter((i) => i.kind !== 'income'),
    [data, subscriptions]
  );
  // Reaches back a month and a half so an early-month due date finds last month's payday.
  const fundingOccurrences = useMemo(
    () => allPaydayOccurrences(paydays, addDays(today, -45), addDays(today, 400)),
    [paydays, today]
  );
  const nextOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const i of outflows) {
      const next = itemOccurrences(i, ctx, today, addDays(today, 400))[0];
      if (next) m.set(i.id, next.dueDate);
    }
    return m;
  }, [outflows, ctx, today]);
  // Card-charged subscriptions are covered by the card's own payment.
  const scheduledMonthly = outflows
    .filter((i) => i.active && !chargedToCard(i, ctx))
    .reduce((s, i) => s + monthlyCents(i, ctx), 0);
  const planner: Planner = useMemo(
    () =>
      data
        ? buildPlanner(withSubscriptions(data.items, subscriptions), data, ctx, today, ahead)
        : { plans: [], statuses: new Map(), overdue: [], unfunded: [] },
    [data, subscriptions, ctx, today, ahead]
  );
  const statusOf = (o: ItemOccurrence) => planner.statuses.get(occurrenceKey(o.item.id, o.dueDate));
  const forecast: Forecast | null = useMemo(
    () => (data ? buildForecast(withSubscriptions(data.items, subscriptions), data, ctx, today) : null),
    [data, subscriptions, ctx, today]
  );
  const shortBy = useMemo(() => forecast?.shortBy ?? new Map<string, number>(), [forecast]);
  const calendarDays = useMemo(
    () =>
      data && view === 'calendar'
        ? buildCalendar(calMonth, withSubscriptions(data.items, subscriptions), data, ctx, today, shortBy)
        : [],
    [data, view, calMonth, subscriptions, ctx, today, shortBy]
  );
  // Owing loans/cards that aren't on the schedule yet.
  const unscheduled = accounts.filter(
    (a) =>
      (a.type === 'loan' || a.type === 'credit') &&
      a.balanceCents < 0 &&
      !outflows.some((i) => (i.kind === 'loan' || i.kind === 'card') && i.accountId === a.id)
  );

  const accountOf = (id: number | null) => (id === null ? undefined : accounts.find((a) => a.id === id));

  const removeItem = async (item: ScheduleItem) => {
    const ok = await confirm({
      title: `Remove "${item.name}" from the schedule?`,
      message: "Payments you've already made stay in your transactions — only the plan is removed.",
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.schedule.removeItem(item.id);
      afterMutation();
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  const addItem = (preset: { kind: OutflowKind; accountId?: number } | null = null) =>
    setItemModal({ open: true, editing: null, preset });

  const remove = async (p: ScheduleItem) => {
    const ok = await confirm({
      title: `Delete "${p.name}"?`,
      message:
        'Bills it funds switch to automatic funding. Salary you already logged stays in your transactions.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.schedule.removeItem(p.id);
      afterMutation();
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  const addPayday = () => setPaydayModal({ open: true, editing: null });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Schedule</h1>
          <div className="page-sub">Plan each payday so every bill is covered on its due date</div>
        </div>
        <div className="head-actions">
          {paydays.length > 0 ? (
            <button className="btn btn-primary" onClick={() => addItem()}>
              <PlusIcon /> Add to schedule
            </button>
          ) : (
            <button className="btn btn-primary" onClick={addPayday}>
              <PlusIcon /> Add payday
            </button>
          )}
        </div>
      </div>

      {!data ? (
        <div className="empty-state">Loading…</div>
      ) : paydays.length === 0 ? (
        <div className="empty-state">
          Start with your paydays — the days your salary arrives and roughly how much. Loans,
          cards and bills are planned around them.
          <br />
          <button className="btn btn-primary" onClick={addPayday}>
            <PlusIcon /> Add your first payday
          </button>
        </div>
      ) : (
        <>
          <div className="segmented sched-views" role="tablist" aria-label="Schedule view">
            {VIEWS.map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                className={view === v ? 'active-account' : ''}
                onClick={() => setView(v)}
              >
                {label}
              </button>
            ))}
          </div>

          {view === 'progress' ? (
            <>
              <DebtPayoff
                items={withSubscriptions(data.items, subscriptions)}
                data={data}
                ctx={ctx}
                today={today}
                onSetup={() => setView('setup')}
              />
              <SavingsGoals
                items={data.items}
                data={data}
                ctx={ctx}
                today={today}
                onAdd={() => addItem({ kind: 'savings' })}
                onEdit={(item) => setItemModal({ open: true, editing: item, preset: null })}
              />
            </>
          ) : view === 'calendar' ? (
            <ScheduleCalendar
              month={calMonth}
              onMonthChange={setCalMonth}
              days={calendarDays}
              today={today}
              onPay={setPaying}
              onLog={setLogging}
            />
          ) : view === 'forecast' && forecast ? (
            <ForecastView
              forecast={forecast}
              onPay={(e) =>
                setPaying({ item: e.item, dueDate: e.dueDate, amountCents: occurrenceAmount(e.item, ctx) })
              }
            />
          ) : view === 'planner' ? (
            <>
              <div className="field-hint sched-intro">
                Each payday covers what's due until the next one (or the bills you pinned to it).
                A red card means more is planned than that payday brings in.
              </div>
              {planner.overdue.length > 0 && (
                <div className="panel plan-card plan-over">
                  <div className="sub-name">Overdue</div>
                  <div className="plan-lines">
                    {planner.overdue.map((o) => (
                      <PlanLine
                        key={occurrenceKey(o.item.id, o.dueDate)}
                        occurrence={o}
                        status={statusOf(o)}
                        shortCents={shortBy.get(occurrenceKey(o.item.id, o.dueDate)) ?? 0}
                        onPay={() => setPaying(o)}
                      />
                    ))}
                  </div>
                </div>
              )}
              {planner.unfunded.length > 0 && (
                <div className="panel plan-card plan-over">
                  <div className="sub-name">Due before any payday</div>
                  <div className="plan-lines">
                    {planner.unfunded.map((o) => (
                      <PlanLine
                        key={occurrenceKey(o.item.id, o.dueDate)}
                        occurrence={o}
                        status={statusOf(o)}
                        shortCents={shortBy.get(occurrenceKey(o.item.id, o.dueDate)) ?? 0}
                        onPay={() => setPaying(o)}
                      />
                    ))}
                  </div>
                </div>
              )}
              <div className="plan-grid">
                {planner.plans.map((plan) => (
                  <PlanCard
                    key={occurrenceKey(plan.payday.item.id, plan.payday.dueDate)}
                    plan={plan}
                    statuses={planner.statuses}
                    shortBy={shortBy}
                    today={today}
                    onLog={() => setLogging(plan.payday)}
                    onPay={setPaying}
                    onSetup={() => setView('setup')}
                  />
                ))}
              </div>
              <div className="plan-more">
                <button className="btn" onClick={() => setAhead((n) => n + 2)}>
                  Show 2 more paydays
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="panel subs-summary sched-summary">
                <div className="subs-summary-item">
                  <span className="subs-summary-label">Income / month</span>
                  <span className="subs-summary-value num">{fmtMoney(incomeMonthly)}</span>
                </div>
                <div className="subs-summary-item">
                  <span className="subs-summary-label">Scheduled / month</span>
                  <span className="subs-summary-value num">≈ {fmtMoney(scheduledMonthly)}</span>
                </div>
                <div className="subs-summary-item">
                  <span className="subs-summary-label">Left / month</span>
                  <span
                    className={`subs-summary-value num ${incomeMonthly - scheduledMonthly < 0 ? 'amount-expense' : 'amount-income'}`}
                  >
                    ≈ {fmtMoney(incomeMonthly - scheduledMonthly)}
                  </span>
                </div>
              </div>

              <div className="panel mt-panel">
                <div className="panel-head">
                  <div className="panel-title">Scheduled</div>
                  <button className="btn" onClick={() => addItem()}>
                    <PlusIcon /> Add
                  </button>
                </div>
                {outflows.length === 0 && unscheduled.length === 0 && (
                  <div className="field-hint">
                    Nothing scheduled yet. Add your loan installments, card payments, bills, weekly
                    allowances and savings goals — each one is planned against a payday.
                  </div>
                )}
                {ITEM_GROUPS.map((group) => {
                  const items = outflows
                    .filter((i) => group.kinds.includes(i.kind))
                    .sort((a, b) => (nextOf.get(a.id) ?? '9999').localeCompare(nextOf.get(b.id) ?? '9999'));
                  const suggestions = group.kinds.includes('loan') ? unscheduled : [];
                  if (items.length === 0 && suggestions.length === 0) return null;
                  return (
                    <div key={group.title} className="sched-group">
                      <div className="sched-group-title">{group.title}</div>
                      {items.map((item) => (
                        <ItemRow
                          key={item.id}
                          item={item}
                          ctx={ctx}
                          today={today}
                          nextDue={nextOf.get(item.id) ?? null}
                          fundingOccurrences={fundingOccurrences}
                          paydays={paydays}
                          onEdit={() =>
                            item.kind === 'subscription'
                              ? setFunding(item)
                              : setItemModal({ open: true, editing: item, preset: null })
                          }
                          onRemove={item.kind === 'subscription' ? null : () => removeItem(item)}
                        />
                      ))}
                      {suggestions.map((a) => (
                        <div className="sub-row sched-rule sched-suggest" key={`suggest-${a.id}`}>
                          <div className="sub-main">
                            <div className="sub-name">
                              {a.name}
                              <span className="type-tag sub-tag">{a.type === 'loan' ? 'Loan' : 'Card'}</span>
                            </div>
                            <div className="sub-meta">
                              Not on your schedule yet
                              {a.dueDay != null
                                ? ` · due on the ${[a.dueDay, a.dueDay2].filter((d): d is number => d != null).map(ordinal).join(' & ')}`
                                : ' · no due day set'}
                            </div>
                          </div>
                          <div className="sub-right">
                            <span className="sub-amount num">{fmtMoney(-a.balanceCents)}</span>
                            <span className="sub-next-muted">owed</span>
                          </div>
                          <div className="sub-actions">
                            <button
                              className="btn"
                              onClick={() => addItem({ kind: a.type === 'loan' ? 'loan' : 'card', accountId: a.id })}
                            >
                              <PlusIcon /> Add
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>

              <div className="panel mt-panel">
                <div className="panel-head">
                  <div className="panel-title">Paydays</div>
                  <button className="btn" onClick={addPayday}>
                    <PlusIcon /> Add payday
                  </button>
                </div>
                {paydays.map((p) => {
                  const account = accountOf(p.accountId);
                  const next = occurrences.find((o) => o.item.id === p.id && o.date >= today);
                  const note = weekendNote(p.weekendShift);
                  return (
                    <div className={`sub-row sched-rule ${p.active ? '' : 'sub-off'}`} key={p.id}>
                      <div className="sub-main">
                        <div className="sub-name">{p.name}</div>
                        <div className="sub-meta">
                          Monthly on the {ordinal(p.dueDay ?? 1)}
                          {note && ` · ${note}`}
                          {account && (
                            <>
                              {' · '}
                              <span className="cat-chip sub-chip">
                                <span className="color-dot" style={{ background: account.color }} />
                                <span>{account.name}</span>
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="sub-right">
                        <span className="sub-amount num">{fmtMoney(p.amountCents)}</span>
                        {next && (
                          <span
                            className="due-tag"
                            title={next.shifted ? `The ${ordinal(p.dueDay ?? 1)} is on a weekend` : undefined}
                          >
                            Next: {shortDateLabel(next.date)}
                          </span>
                        )}
                      </div>
                      <div className="sub-actions">
                        <button
                          className="btn-icon"
                          title="Edit"
                          onClick={() => setPaydayModal({ open: true, editing: p })}
                        >
                          <PencilIcon />
                        </button>
                        <button className="btn-icon danger" title="Delete" onClick={() => remove(p)}>
                          <TrashIcon />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

            </>
          )}
        </>
      )}

      {paydayModal.open && (
        <PaydayModal
          initial={paydayModal.editing}
          accounts={accounts}
          categories={categories}
          onClose={() => setPaydayModal({ open: false, editing: null })}
          onSaved={afterMutation}
        />
      )}
      {logging && (
        <LogReceivedModal
          occurrence={logging}
          accounts={accounts}
          onClose={() => setLogging(null)}
          onSaved={afterMutation}
        />
      )}
      {itemModal.open && (
        <ScheduleItemModal
          initial={itemModal.editing}
          preset={itemModal.preset}
          accounts={accounts}
          categories={categories}
          paydays={paydays}
          subscriptions={subscriptions}
          scheduledAccountIds={outflows
            .filter((i) => (i.kind === 'loan' || i.kind === 'card') && i.accountId !== null)
            .map((i) => i.accountId as number)}
          onClose={() => setItemModal({ open: false, editing: null, preset: null })}
          onSaved={afterMutation}
        />
      )}
      {paying && (
        <MarkPaidModal
          occurrence={paying}
          status={statusOf(paying)}
          accounts={accounts}
          categories={categories}
          onClose={() => setPaying(null)}
          onSaved={afterMutation}
        />
      )}
      {funding && (
        <FundingModal
          item={funding}
          ctx={ctx}
          paydays={paydays}
          onClose={() => setFunding(null)}
          onSaved={afterMutation}
        />
      )}
    </div>
  );
}

/**
 * The 60-day cash projection: headline numbers, the dates you'd come up short,
 * the balance chart, and a day-by-day list (the chart's table view).
 */
function ForecastView({ forecast, onPay }: { forecast: Forecast; onPay: (e: ForecastEvent) => void }) {
  const { startCents, cashAccounts, setAside, days, shortfalls, lowest, endCents } = forecast;
  const eventDays = days.filter((d) => d.events.length > 0);
  return (
    <>
      <div className="panel subs-summary sched-summary">
        <div className="subs-summary-item">
          <span className="subs-summary-label">Cash now</span>
          <span className="subs-summary-value num">{fmtMoney(startCents)}</span>
        </div>
        <div className="subs-summary-item">
          <span className="subs-summary-label">Lowest · {shortDateLabel(lowest.date)}</span>
          <span className={`subs-summary-value num ${lowest.balanceCents < 0 ? 'amount-expense' : ''}`}>
            {fmtMoney(lowest.balanceCents)}
          </span>
        </div>
        <div className="subs-summary-item">
          <span className="subs-summary-label">In {FORECAST_DAYS} days</span>
          <span className={`subs-summary-value num ${endCents < 0 ? 'amount-expense' : ''}`}>{fmtMoney(endCents)}</span>
        </div>
        <div className="subs-summary-item">
          <span className="subs-summary-label">Shortfalls</span>
          <span className={`subs-summary-value ${shortfalls.length ? 'amount-expense' : 'amount-income'}`}>
            {shortfalls.length || 'None'}
          </span>
        </div>
      </div>
      <div className="field-hint sched-note">
        Starts from today's balance in {cashAccounts.map((a) => a.name).join(' + ') || 'your debit accounts'}.
        Paydays you haven't logged are added on their expected date; what's still unpaid comes off on its due
        date (anything overdue, today). Card-charged items are left to the card's own payment.
        {setAside.length > 0 &&
          ` ${setAside.map((a) => `${a.name} (${fmtMoney(a.balanceCents)})`).join(', ')} ${
            setAside.length === 1 ? "isn't" : "aren't"
          } counted — your savings goals pay into ${setAside.length === 1 ? 'it' : 'them'}.`}
      </div>

      {shortfalls.length > 0 ? (
        <div className="panel mt-panel plan-card plan-over">
          <div className="panel-title" style={{ marginBottom: 0 }}>
            Not enough on these dates
          </div>
          <div className="plan-lines">
            {shortfalls.map((e) => (
              <div className="fc-short-row" key={occurrenceKey(e.item.id, e.dueDate)}>
                <div>
                  <strong className="amount-expense">Short {fmtMoney(e.shortCents)}</strong> on{' '}
                  {shortDateLabel(e.date)} for {e.item.name}
                </div>
                <div className="sub-next-muted">
                  {fmtMoney(Math.max(0, e.balanceBefore))} on hand · {fmtMoney(e.amountCents)} due
                  {e.overdue && ` (overdue since ${shortDateLabel(e.dueDate)})`}
                </div>
              </div>
            ))}
          </div>
          <div className="field-hint">
            To cover it: move money in from savings, pay part now and the rest after your next payday, or
            trim something that's due before it.
          </div>
        </div>
      ) : (
        <div className="panel mt-panel fc-ok">
          <CheckIcon /> Every due date in the next {FORECAST_DAYS} days is covered.
        </div>
      )}

      <div className="panel mt-panel">
        <div className="panel-title">Cash on hand · next {FORECAST_DAYS} days</div>
        <ForecastChart days={days} />
      </div>

      <div className="panel mt-panel">
        <div className="panel-head">
          <div className="panel-title">Day by day</div>
          <span className="sub-next-muted">amount · balance after</span>
        </div>
        {eventDays.length === 0 ? (
          <div className="field-hint">Nothing comes in or goes out in the next {FORECAST_DAYS} days.</div>
        ) : (
          <div className="plan-lines">
            {eventDays.flatMap((d) =>
              d.events.map((e, idx) => (
                <div key={`${d.date}-${idx}`} className={`plan-line ${e.shortCents > 0 ? 'fc-row-short' : ''}`}>
                  <span className="plan-line-date">{idx === 0 ? shortDateLabel(d.date) : ''}</span>
                  <span className="plan-line-name">
                    <span>{e.item.name}</span>
                    {e.kind === 'in' && <span className="type-tag sub-tag">Payday</span>}
                    {e.overdue && <span className="due-tag due-now">Overdue</span>}
                    {e.shortCents > 0 && <span className="due-tag due-now">Short {fmtMoney(e.shortCents)}</span>}
                  </span>
                  <span className="fc-amounts">
                    <span className={`num plan-line-amount ${e.kind === 'in' ? 'amount-income' : ''}`}>
                      {e.kind === 'in' ? '+' : '−'}
                      {fmtMoney(e.amountCents)}
                    </span>
                    <span className={`num sub-next-muted ${e.balanceAfter < 0 ? 'amount-expense' : ''}`}>
                      {fmtMoney(e.balanceAfter)}
                    </span>
                  </span>
                  <span className="plan-line-action">
                    {e.kind === 'out' && e.item.kind !== 'subscription' && (
                      <button className="btn-icon plan-pay" title="Mark as paid" onClick={() => onPay(e)}>
                        <BanknoteIcon />
                      </button>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** One payday: its income, every due date it funds, and what's left — red when over-allocated. */
function PlanCard({
  plan,
  statuses,
  shortBy,
  today,
  onLog,
  onPay,
  onSetup,
}: {
  plan: PaydayPlan;
  statuses: Map<string, DueStatus>;
  shortBy: Map<string, number>;
  today: string;
  onLog: () => void;
  onPay: (o: ItemOccurrence) => void;
  onSetup: () => void;
}) {
  const { payday, closed, status, incomeCents, outflows, scheduledCents, paidCents, leftCents } = plan;
  const over = !closed && leftCents < 0;
  const received = status.state === 'received';
  const tag = statusTag(status, payday.date, today);
  const pct = incomeCents > 0 ? (scheduledCents / incomeCents) * 100 : scheduledCents > 0 ? 100 : 0;
  return (
    <div className={`panel plan-card ${over ? 'plan-over' : ''}`}>
      <div className="plan-head">
        <div className="plan-title">
          <div className="sub-name">
            {shortDateLabel(payday.date)}
            <span className="sched-dim">{payday.item.name}</span>
          </div>
          <div className="sub-meta">
            <span className={`due-tag ${tag.cls}`}>{tag.label}</span>
            {payday.shifted && <span>Moved from {shortDateLabel(payday.dueDate)}</span>}
            {received && status.payments.length === 0 && <span>Found in your transactions</span>}
          </div>
        </div>
        <div className="plan-income">
          <span className={`sub-amount num ${received ? 'amount-income' : ''}`}>{fmtMoney(incomeCents)}</span>
          {received ? (
            status.receivedCents !== payday.item.amountCents && (
              <span className="sub-next-muted">Expected {fmtMoney(payday.item.amountCents)}</span>
            )
          ) : (
            <span className="sub-next-muted">expected</span>
          )}
        </div>
        <div className="sub-actions">
          {received ? (
            <button className="btn-icon" title="Log another amount" onClick={onLog}>
              <PlusIcon />
            </button>
          ) : payday.date <= addDays(today, 3) ? (
            <button className="btn" title="Log received" onClick={onLog}>
              <BanknoteIcon />
              <span className="sched-log-label">Log received</span>
            </button>
          ) : (
            // Weeks away: keep the card quiet, but logging early stays possible.
            <button className="btn-icon" title="Log received" onClick={onLog}>
              <BanknoteIcon />
            </button>
          )}
        </div>
      </div>

      <div className="plan-lines">
        {outflows.length === 0 ? (
          <div className="field-hint plan-empty">
            Nothing is scheduled from this payday.{' '}
            <button type="button" className="link-button" onClick={onSetup}>
              Add bills in Setup
            </button>
          </div>
        ) : (
          outflows.map((o) => {
            const key = occurrenceKey(o.item.id, o.dueDate);
            return (
              <PlanLine
                key={key}
                occurrence={o}
                status={statuses.get(key)}
                shortCents={shortBy.get(key) ?? 0}
                onPay={() => onPay(o)}
              />
            );
          })
        )}
      </div>

      {closed ? (
        <div className="plan-totals">
          <span>
            Still set aside from this payday <strong className="num">{fmtMoney(scheduledCents)}</strong>
          </span>
        </div>
      ) : (
        <>
          <ProgressBar pct={pct} />
          <div className="plan-totals">
            <span>
              Scheduled <strong className="num">{fmtMoney(scheduledCents)}</strong>
              {paidCents > 0 && <> · paid {fmtMoney(paidCents)}</>}
            </span>
            <span className={over ? 'amount-expense' : 'amount-income'}>
              {over ? 'Over by ' : 'Left '}
              <strong className="num">{fmtMoney(Math.abs(leftCents))}</strong>
            </span>
          </div>
        </>
      )}
      {over && (
        <div className="field-hint">
          More is planned than this payday brings in. Move a bill to another payday (Setup → edit →
          Funded by) or lower an amount.
        </div>
      )}
    </div>
  );
}

/** One planned outflow: when it's due, how it's funded, and what's left. */
function ItemRow({
  item,
  ctx,
  today,
  nextDue,
  fundingOccurrences,
  paydays,
  onEdit,
  onRemove,
}: {
  item: ScheduleItem;
  ctx: ScheduleContext;
  today: string;
  nextDue: string | null;
  fundingOccurrences: PaydayOccurrence[];
  paydays: ScheduleItem[];
  onEdit: () => void;
  onRemove: (() => void) | null;
}) {
  const { accounts, subscriptions } = ctx;
  const sub = item.kind === 'subscription' ? subscriptions.find((s) => s.id === item.subscriptionId) : undefined;
  const target = item.kind === 'loan' || item.kind === 'card' ? accounts.find((a) => a.id === item.accountId) : undefined;
  const onCard = chargedToCard(item, ctx);
  const amount = occurrenceAmount(item, ctx);
  const left = remainingCount(item, ctx, today);

  const meta: ReactNode[] = [];
  if (item.kind === 'loan' || item.kind === 'card') {
    const days = monthlyDueDays(item, accounts);
    meta.push(
      target === undefined ? (
        <span className="sched-warn">Account deleted</span>
      ) : days.length ? (
        `Due on the ${days.map(ordinal).join(' & ')}`
      ) : (
        <span className="sched-warn">No due day on the account</span>
      )
    );
  } else if (item.kind === 'bill') {
    meta.push(`Due on the ${ordinal(item.dueDay ?? 1)}`);
  } else if (item.kind === 'savings') {
    meta.push(`Monthly on the ${ordinal(item.dueDay ?? 1)}`);
  } else if (item.kind === 'allowance') {
    meta.push(`Every ${WEEKDAY_LABEL[item.weekDay ?? 0]}`);
  } else if (sub) {
    meta.push(`${subscriptionCycle(sub)}, charged automatically`);
  }
  if (left !== null && item.endDate !== null) {
    meta.push(left > 0 ? `${left} left · last ${shortDateLabel(item.endDate)}` : 'Ended');
  }
  const source = sub
    ? accounts.find((a) => a.id === sub.accountId)
    : accounts.find((a) => a.id === item.payFromAccountId);
  if (source) {
    meta.push(
      <span className="cat-chip sub-chip">
        <span className="color-dot" style={{ background: source.color }} />
        <span>{source.name}</span>
      </span>
    );
  }
  if (onCard) {
    meta.push('covered by the card payment');
  } else if (item.kind !== 'allowance' && paydays.length > 0 && nextDue) {
    const payday = fundingPayday(item, nextDue, fundingOccurrences);
    meta.push(
      payday
        ? `Funded by ${payday.item.name}${item.fundedBy === null ? ' (auto)' : ''}`
        : 'No payday before it'
    );
  }

  let detail: string | null = null;
  if (target && target.balanceCents < 0) detail = `Owes ${fmtMoney(-target.balanceCents)}`;
  else if (item.kind === 'savings' && item.goalCents !== null) detail = `Goal ${fmtMoney(item.goalCents)}`;
  else if (item.amountMode === 'avg3') detail = item.estimateCents !== null ? '3-month average' : 'No history yet';

  return (
    <div className={`sub-row sched-rule sched-item ${item.active ? '' : 'sub-off'}`}>
      <div className="sub-main">
        <div className="sub-name">
          {item.name}
          <span className="type-tag sub-tag">{KIND_LABEL[item.kind]}</span>
        </div>
        <div className="sub-meta">
          {meta.map((m, i) => (
            <span key={i} className="sched-meta-part">
              {m}
            </span>
          ))}
        </div>
      </div>
      <div className="sub-right">
        <span className="sub-amount num">
          {item.amountMode === 'avg3' ? '≈ ' : ''}
          {fmtMoney(amount)}
          {item.kind === 'allowance' && <span className="sched-unit"> /wk</span>}
        </span>
        {detail && <span className="sub-next-muted">{detail}</span>}
        {nextDue && <span className="due-tag">Next: {shortDateLabel(nextDue)}</span>}
      </div>
      <div className="sub-actions">
        <button className="btn-icon" title={sub ? 'Choose the funding payday' : 'Edit'} onClick={onEdit}>
          <PencilIcon />
        </button>
        {onRemove && (
          <button className="btn-icon danger" title="Remove from schedule" onClick={onRemove}>
            <TrashIcon />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Subscriptions keep their own amount and dates (and charge automatically);
 * this only picks which payday sets money aside for one. Saving the first
 * pin creates its schedule row.
 */
function FundingModal({
  item,
  ctx,
  paydays,
  onClose,
  onSaved,
}: {
  item: ScheduleItem;
  ctx: ScheduleContext;
  paydays: ScheduleItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const sub = ctx.subscriptions.find((s) => s.id === item.subscriptionId);
  const account = ctx.accounts.find((a) => a.id === sub?.accountId);
  const [fundedBy, setFundedBy] = useState(item.fundedBy != null ? String(item.fundedBy) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = fundedBy ? Number(fundedBy) : null;
    setSaving(true);
    try {
      if (item.id > 0) await api.schedule.updateItem(item.id, { ...toInput(item), fundedBy: value });
      else if (value !== null) await api.schedule.createItem({ ...toInput(item), fundedBy: value });
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={`${item.name} · funding`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        {sub && (
          <div className="field-hint">
            {fmtMoney(sub.amountCents)} · {subscriptionCycle(sub).toLowerCase()}
            {account && ` from ${account.name}`}, charged automatically. Change the amount or date on
            the Subscriptions page.
          </div>
        )}
        <div className="field">
          <label htmlFor="funding-payday">Funded by</label>
          <select id="funding-payday" value={fundedBy} onChange={(e) => setFundedBy(e.target.value)}>
            <option value="">Automatic — the latest payday before each charge</option>
            {paydays.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <CheckIcon /> Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PaydayModal({
  initial,
  accounts,
  categories,
  onClose,
  onSaved,
}: {
  initial: ScheduleItem | null;
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const debitAccounts = useMemo(
    () => accounts.filter((a) => a.type === 'debit' && (!isArchived(a) || a.id === initial?.accountId)),
    [accounts, initial]
  );
  const incomeCategories = useMemo(() => categories.filter((c) => c.type === 'income'), [categories]);

  const [day, setDay] = useState(initial?.dueDay != null ? String(initial.dueDay) : '');
  // The name follows the day ("Payday 8th") until the user types their own.
  const [name, setName] = useState(initial?.name ?? '');
  const [nameTouched, setNameTouched] = useState(initial !== null);
  const [amount, setAmount] = useState(initial ? centsToInput(initial.amountCents) : '');
  const [accountId, setAccountId] = useState<string>(
    initial
      ? initial.accountId != null
        ? String(initial.accountId)
        : ''
      : debitAccounts.length === 1
        ? String(debitAccounts[0].id)
        : ''
  );
  const [categoryId, setCategoryId] = useState<string>(() => {
    if (initial) return initial.categoryId != null ? String(initial.categoryId) : '';
    const salary = incomeCategories.find((c) => c.name.toLowerCase() === 'salary');
    return salary ? String(salary.id) : '';
  });
  const [weekendShift, setWeekendShift] = useState<WeekendShift>(initial?.weekendShift ?? 'before');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const autoName = day ? `Payday ${ordinal(Number(day))}` : '';
  const shownName = nameTouched ? name : autoName;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amountCents = parseAmountToCents(amount);
    if (!day) {
      setError('Pick the day of the month your salary arrives');
      return;
    }
    if (amountCents === null) {
      setError('Enter the amount you expect, e.g. 54,000.00');
      return;
    }
    if (!shownName.trim()) {
      setError('Give the payday a name');
      return;
    }
    setSaving(true);
    setError('');
    const data: ScheduleItemInput = {
      kind: 'income',
      name: shownName.trim(),
      accountId: accountId ? Number(accountId) : null,
      subscriptionId: null,
      categoryId: categoryId ? Number(categoryId) : null,
      amountMode: 'fixed',
      amountCents,
      matchKeyword: null,
      dueDay: Number(day),
      weekDay: null,
      fundedBy: null,
      weekendShift,
      // A new payday tracks from the start of this month, so an earlier
      // payday this month shows up to be logged (or is matched to salary
      // already in Transactions). Editing keeps the original start.
      startDate: initial ? null : `${todayStr().slice(0, 8)}01`,
      endDate: initial?.endDate ?? null,
      goalCents: null,
      goalMilestones: [],
      payFromAccountId: null,
      active: initial?.active ?? true,
    };
    try {
      if (initial) await api.schedule.updateItem(initial.id, data);
      else await api.schedule.createItem(data);
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  const weekendRules: WeekendShift[] = ['before', 'after', 'none'];

  return (
    <Modal title={initial ? 'Edit payday' : 'Add payday'} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="form-row">
          <div className="field">
            <label htmlFor="payday-day">Day of the month</label>
            <select id="payday-day" value={day} onChange={(e) => setDay(e.target.value)} autoFocus>
              <option value="" disabled>
                Pick a day
              </option>
              {DAYS_OF_MONTH.map((d) => (
                <option key={d} value={d}>
                  {ordinal(d)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="payday-amount">Expected amount</label>
            <MoneyInput id="payday-amount" value={amount} onChange={setAmount} />
          </div>
        </div>
        {Number(day) >= 29 && (
          <div className="field-hint">In shorter months it lands on the last day of the month.</div>
        )}

        <div className="field">
          <label htmlFor="payday-name">Name</label>
          <input
            id="payday-name"
            type="text"
            value={shownName}
            placeholder="e.g. Payday 8th"
            maxLength={60}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
          />
        </div>

        <div className="field">
          <label>If it falls on a weekend</label>
          <div className="segmented" role="group" aria-label="If it falls on a weekend">
            {weekendRules.map((r) => (
              <button
                key={r}
                type="button"
                className={weekendShift === r ? 'active-account' : ''}
                onClick={() => setWeekendShift(r)}
              >
                {WEEKEND_RULE_LABEL[r]}
              </button>
            ))}
          </div>
          <div className="field-hint">
            {weekendShift === 'none'
              ? 'Expected on the day itself, even on a Saturday or Sunday.'
              : `A payday on a Saturday or Sunday is expected the ${WEEKEND_RULE_LABEL[weekendShift]}.`}{' '}
            Public holidays aren't moved.
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="payday-account">Lands in</label>
            <select id="payday-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Choose when logging</option>
              {debitAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="payday-category">Category</label>
            <select id="payday-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Uncategorized</option>
              {incomeCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field-hint">
          Logging a payday adds an income transaction to this account. Salary you add on the
          Transactions page to the same account and category counts too.
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {initial ? <CheckIcon /> : <PlusIcon />} {initial ? 'Save changes' : 'Add payday'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
