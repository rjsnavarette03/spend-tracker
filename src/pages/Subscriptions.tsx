import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { Account, Category, Subscription, SubscriptionCycle } from '../../shared/types';
import { api } from '../api';
import { useAppContext } from '../App';
import { confirm, toast } from '../components/feedback';
import { PauseIcon, PencilIcon, PlayIcon, PlusIcon, TrashIcon } from '../components/Icons';
import { Modal } from '../components/Modal';
import { MoneyInput } from '../components/MoneyInput';
import {
  centsToInput,
  cleanError,
  dateLabel,
  fmtMoney,
  ordinal,
  parseAmountToCents,
  todayStr,
} from '../format';

function cycleLabel(s: Subscription): string {
  return s.cycle === 'monthly'
    ? `Monthly on the ${ordinal(s.billDay ?? 1)}`
    : `Every ${s.intervalDays} day${s.intervalDays === 1 ? '' : 's'}`;
}

/** Days from today until the next charge, for the urgency pill. */
function daysUntil(nextDate: string): number {
  const [y, m, d] = nextDate.split('-').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86400000);
}

function chargeLabel(nextDate: string): string {
  const days = daysUntil(nextDate);
  if (days <= 0) return 'Charges today';
  if (days === 1) return 'Charges tomorrow';
  const [y, m, d] = nextDate.split('-').map(Number);
  return 'Charges ' + new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Rough normalized monthly cost — interval subs scale by 30/interval. */
function monthlyCents(s: Subscription): number {
  if (s.cycle === 'monthly') return s.amountCents;
  return Math.round((s.amountCents * 30) / Math.max(1, s.intervalDays ?? 30));
}

export function Subscriptions() {
  const { accounts, categories, onDataChanged } = useAppContext();
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [modal, setModal] = useState<{ open: boolean; editing: Subscription | null }>({
    open: false,
    editing: null,
  });

  const load = useCallback(async () => {
    try {
      setSubs(await api.subscriptions.list());
      setLoaded(true);
    } catch (err) {
      toast.error(cleanError(err));
    }
  }, []);

  useEffect(() => {
    // The list request also triggers server-side auto-charging of anything
    // due, so refresh the shared account balances alongside.
    void load().then(() => onDataChanged());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, [load]);

  const afterMutation = () => {
    void load();
    onDataChanged();
  };

  const active = subs.filter((s) => s.active && s.accountId != null);
  const estMonthly = active.reduce((sum, s) => sum + monthlyCents(s), 0);

  const toggleActive = async (s: Subscription) => {
    if (s.accountId == null) {
      toast.error('Link an account first — edit the subscription and pick one.');
      return;
    }
    try {
      await api.subscriptions.update(s.id, {
        name: s.name,
        amountCents: s.amountCents,
        accountId: s.accountId,
        categoryId: s.categoryId,
        cycle: s.cycle,
        intervalDays: s.intervalDays,
        nextDate: s.nextDate,
        active: !s.active,
      });
      afterMutation();
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  const remove = async (s: Subscription) => {
    const ok = await confirm({
      title: `Delete "${s.name}"?`,
      message: 'Future charges stop. Past charges stay in your transaction history.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.subscriptions.remove(s.id);
      afterMutation();
    } catch (err) {
      toast.error(cleanError(err));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Subscriptions</h1>
          <div className="page-sub">Recurring bills, charged automatically when the day comes</div>
        </div>
        <div className="head-actions">
          <button
            className="btn btn-primary"
            onClick={() => setModal({ open: true, editing: null })}
            disabled={accounts.filter((a) => a.type !== 'loan').length === 0}
            title={
              accounts.filter((a) => a.type !== 'loan').length === 0
                ? 'Add a debit or credit account first'
                : undefined
            }
          >
            <PlusIcon /> Add subscription
          </button>
        </div>
      </div>

      {!loaded ? (
        <div className="empty-state">Loading…</div>
      ) : subs.length === 0 ? (
        <div className="empty-state">
          No subscriptions yet. Add your internet, Netflix, Spotify and other recurring bills —
          each one auto-deducts from its linked account on the charge date, so you never forget
          to record them.
          <br />
          <button
            className="btn btn-primary"
            onClick={() => setModal({ open: true, editing: null })}
            disabled={accounts.filter((a) => a.type !== 'loan').length === 0}
          >
            <PlusIcon /> Add your first subscription
          </button>
        </div>
      ) : (
        <>
          <div className="panel subs-summary">
            <div className="subs-summary-item">
              <span className="subs-summary-label">Active</span>
              <span className="subs-summary-value">{active.length}</span>
            </div>
            <div className="networth-divider" />
            <div className="subs-summary-item">
              <span className="subs-summary-label">Estimated monthly cost</span>
              <span className="subs-summary-value num">≈ {fmtMoney(estMonthly)}</span>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            {subs.map((s) => {
              const days = daysUntil(s.nextDate);
              const running = s.active && s.accountId != null;
              return (
                <div className={`sub-row ${running ? '' : 'sub-off'}`} key={s.id}>
                  <div className="sub-main">
                    <div className="sub-name">
                      {s.name}
                      {!s.active && <span className="type-tag sub-tag">Paused</span>}
                      {s.active && s.accountId == null && (
                        <span className="type-tag sub-tag sub-tag-warn">No account</span>
                      )}
                    </div>
                    <div className="sub-meta">
                      {cycleLabel(s)}
                      {' · '}
                      {s.accountId != null ? (
                        <span className="cat-chip sub-chip">
                          <span
                            className="color-dot"
                            style={{ background: s.accountColor ?? '#64748b' }}
                          />
                          <span>{s.accountName}</span>
                        </span>
                      ) : (
                        'link an account to resume charging'
                      )}
                      {s.categoryName && (
                        <>
                          {' · '}
                          <span className="cat-chip sub-chip">
                            <span
                              className="color-dot"
                              style={{ background: s.categoryColor ?? '#64748b' }}
                            />
                            <span>{s.categoryName}</span>
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="sub-right">
                    <span className="sub-amount num">{fmtMoney(s.amountCents)}</span>
                    {running ? (
                      <span
                        className={`due-tag ${days <= 2 ? 'due-now' : days <= 7 ? 'due-soon' : ''}`}
                        title={`Next charge: ${dateLabel(s.nextDate)}`}
                      >
                        {chargeLabel(s.nextDate)}
                      </span>
                    ) : (
                      <span className="sub-next-muted">Next: {dateLabel(s.nextDate)}</span>
                    )}
                  </div>
                  <div className="sub-actions">
                    <button
                      className="btn-icon"
                      title={s.active ? 'Pause' : 'Resume'}
                      onClick={() => toggleActive(s)}
                    >
                      {s.active ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <button
                      className="btn-icon"
                      title="Edit"
                      onClick={() => setModal({ open: true, editing: s })}
                    >
                      <PencilIcon />
                    </button>
                    <button className="btn-icon danger" title="Delete" onClick={() => remove(s)}>
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {modal.open && (
        <SubscriptionModal
          initial={modal.editing}
          accounts={accounts}
          categories={categories}
          onClose={() => setModal({ open: false, editing: null })}
          onSaved={afterMutation}
        />
      )}
    </div>
  );
}

function SubscriptionModal({
  initial,
  accounts,
  categories,
  onClose,
  onSaved,
}: {
  initial: Subscription | null;
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [amount, setAmount] = useState(initial ? centsToInput(initial.amountCents) : '');
  const [accountId, setAccountId] = useState<string>(
    initial?.accountId != null ? String(initial.accountId) : ''
  );
  const [categoryId, setCategoryId] = useState<string>(
    initial?.categoryId != null ? String(initial.categoryId) : ''
  );
  const [cycle, setCycle] = useState<SubscriptionCycle>(initial?.cycle ?? 'monthly');
  const [intervalDays, setIntervalDays] = useState(String(initial?.intervalDays ?? 30));
  const [nextDate, setNextDate] = useState(initial?.nextDate ?? todayStr());
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Charges are expenses paid from cash/bank or onto a card — never a loan.
  const debitAccounts = useMemo(() => accounts.filter((a) => a.type === 'debit'), [accounts]);
  const creditAccounts = useMemo(() => accounts.filter((a) => a.type === 'credit'), [accounts]);
  const expenseCategories = useMemo(
    () => categories.filter((c) => c.type === 'expense'),
    [categories]
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amountCents = parseAmountToCents(amount);
    if (!name.trim()) {
      setError('Give the subscription a name, e.g. Netflix');
      return;
    }
    if (amountCents === null) {
      setError('Enter a positive amount, e.g. 549.00');
      return;
    }
    if (!accountId) {
      setError('Pick the account it charges');
      return;
    }
    const days = Number(intervalDays);
    if (cycle === 'interval' && (!Number.isInteger(days) || days < 1 || days > 365)) {
      setError('Days between charges must be between 1 and 365');
      return;
    }
    if (!nextDate) {
      setError('Pick the next charge date');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const data = {
        name: name.trim(),
        amountCents,
        accountId: Number(accountId),
        categoryId: categoryId ? Number(categoryId) : null,
        cycle,
        intervalDays: cycle === 'interval' ? days : null,
        nextDate,
        active: initial?.active ?? true,
      };
      if (initial) await api.subscriptions.update(initial.id, data);
      else await api.subscriptions.create(data);
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit subscription' : 'Add subscription'} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="sub-name">Name</label>
          <input
            id="sub-name"
            type="text"
            placeholder="e.g. Netflix, PLDT Internet"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoFocus
          />
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="sub-amount">Amount</label>
            <MoneyInput id="sub-amount" value={amount} onChange={setAmount} />
          </div>
          <div className="field">
            <label htmlFor="sub-next">Next charge date</label>
            {/* min only when creating: a paused/unlinked sub legitimately
                carries a past date, and blocking Save on it would trap the
                edit. The server clamps stale/past dates safely. */}
            <input
              id="sub-next"
              type="date"
              value={nextDate}
              min={initial ? undefined : todayStr()}
              onChange={(e) => setNextDate(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label>Billing cycle</label>
          <div className="segmented" role="tablist">
            <button
              type="button"
              className={cycle === 'monthly' ? 'active-account' : ''}
              onClick={() => setCycle('monthly')}
            >
              Monthly
            </button>
            <button
              type="button"
              className={cycle === 'interval' ? 'active-account' : ''}
              onClick={() => setCycle('interval')}
            >
              Every N days
            </button>
          </div>
          {cycle === 'monthly' ? (
            <div className="field-hint">
              {/* With the date untouched the server keeps the original anchor
                  (a "31st" sub can currently READ Feb 28) — mirror that. */}
              Repeats on the{' '}
              {ordinal(
                initial && initial.cycle === 'monthly' && nextDate === initial.nextDate
                  ? initial.billDay ?? (Number(nextDate.slice(8, 10)) || 1)
                  : Number(nextDate.slice(8, 10)) || 1
              )}{' '}
              of every month (shorter months charge on their last day).
            </div>
          ) : (
            <div className="field-hint">
              Repeats a fixed number of days after each charge — e.g. 30-day prepaid plans.
            </div>
          )}
        </div>

        {cycle === 'interval' && (
          <div className="field">
            <label htmlFor="sub-days">Days between charges</label>
            <input
              id="sub-days"
              type="number"
              min={1}
              max={365}
              value={intervalDays}
              onChange={(e) => setIntervalDays(e.target.value)}
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="sub-account">Charge account</label>
          <select id="sub-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="" disabled>
              Pick an account
            </option>
            {debitAccounts.length > 0 && (
              <optgroup label="Debit">
                {debitAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({fmtMoney(a.balanceCents)})
                  </option>
                ))}
              </optgroup>
            )}
            {creditAccounts.length > 0 && (
              <optgroup label="Credit">
                {creditAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({fmtMoney(a.balanceCents)})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div className="field">
          <label htmlFor="sub-category">Category (optional)</label>
          <select
            id="sub-category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">Uncategorized</option>
            {expenseCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {initial ? 'Save changes' : 'Add subscription'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
