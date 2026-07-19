import { useCallback, useEffect, useState } from 'react';
import type {
  Account,
  BreakdownRow,
  Budget,
  Category,
  MonthlySummary,
  Transaction,
} from '../../shared/types';
import { api } from '../api';
import { toast } from '../components/feedback';
import { DonutChart } from '../components/DonutChart';
import { PlusIcon, TransferIcon } from '../components/Icons';
import { PeriodPicker } from '../components/PeriodPicker';
import { ProgressBar } from '../components/ProgressBar';
import { TransactionModal } from '../components/TransactionModal';
import { TransferModal } from '../components/TransferModal';
import { TrendChart } from '../components/TrendChart';
import {
  CADENCE_PERIOD,
  CADENCE_SHORT,
  cleanError,
  dateLabel,
  fmtMoney,
  fmtSigned,
  periodLabel,
} from '../format';
import type { Period } from '../format';

interface DashboardData {
  summary: MonthlySummary;
  trend: MonthlySummary[];
  breakdown: BreakdownRow[];
  budgets: Budget[];
  recent: Transaction[];
}

export function Dashboard({
  period,
  setPeriod,
  categories,
  accounts,
  availableYears,
  onDataChanged,
}: {
  period: Period;
  setPeriod: (p: Period) => void;
  categories: Category[];
  accounts: Account[];
  availableYears: number[];
  onDataChanged: () => void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);

  // Budgets & the 6-month trend stay monthly, keyed to the period's month.
  const budgetMonth = period.start.slice(0, 7);

  const load = useCallback(async () => {
    try {
      const [summary, trend, breakdown, budgets, txs] = await Promise.all([
        api.reports.summary(period.start, period.end),
        api.reports.trend(budgetMonth, 6),
        api.reports.breakdown(period.start, period.end, 'expense'),
        api.budgets.list(),
        api.transactions.list({ from: period.start, to: period.end }),
      ]);
      setData({ summary, trend, breakdown, budgets, recent: txs.slice(0, 8) });
    } catch (err) {
      toast.error(cleanError(err));
    }
  }, [period, budgetMonth]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <div className="loading">Loading…</div>;

  const { summary, trend, breakdown, budgets, recent } = data;
  const net = summary.incomeCents - summary.expenseCents;
  // Transfers move money between debit accounts, so two are needed.
  const debitCount = accounts.filter((a) => a.type === 'debit').length;
  // Budgets are recurring rules at mixed cadences, so a single "% used" across
  // all of them would be apples-to-oranges. Track how many are within limit
  // (each compared against its own cadence's current period) instead.
  const activeBudgets = budgets.filter((b) => b.amountCents > 0);
  const overCount = activeBudgets.filter((b) => b.spentCents > b.amountCents).length;
  const onTrack = activeBudgets.length - overCount;
  const savingsRate = summary.incomeCents > 0 ? Math.round((net / summary.incomeCents) * 100) : null;
  const topBudgets = [...activeBudgets].sort((a, b) => b.amountCents - a.amountCents).slice(0, 5);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-sub">{periodLabel(period)} overview</div>
        </div>
        <div className="head-actions">
          <PeriodPicker value={period} onChange={setPeriod} availableYears={availableYears} />
          <button
            className="btn"
            onClick={() => setShowTransfer(true)}
            disabled={debitCount < 2}
            title={debitCount < 2 ? 'You need at least two debit accounts to transfer' : undefined}
          >
            <TransferIcon /> Transfer
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <PlusIcon /> Add transaction
          </button>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Income</div>
          <div className="stat-value green">{fmtMoney(summary.incomeCents)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Expenses</div>
          <div className="stat-value red">{fmtMoney(summary.expenseCents)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net</div>
          <div className={`stat-value ${net >= 0 ? 'green' : 'red'}`}>{fmtMoney(net)}</div>
          {savingsRate !== null && <div className="stat-sub">{savingsRate}% of income kept</div>}
        </div>
        <div className="stat-card">
          <div className="stat-label">Budgets on track</div>
          <div className={`stat-value ${overCount > 0 ? 'red' : activeBudgets.length ? 'green' : ''}`}>
            {activeBudgets.length ? `${onTrack}/${activeBudgets.length}` : '—'}
          </div>
          <div className="stat-sub">
            {activeBudgets.length === 0
              ? 'No budgets set'
              : overCount > 0
                ? `${overCount} over limit`
                : 'All within budget'}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-title">
            Income vs expenses · last 6 months
            <span className="chart-legend">
              <span>
                <span className="legend-dot" style={{ background: 'var(--green)' }} />
                Income
              </span>
              <span>
                <span className="legend-dot" style={{ background: 'var(--red)' }} />
                Expenses
              </span>
            </span>
          </div>
          <TrendChart data={trend} />
        </div>
        <div className="panel">
          <div className="panel-title">Spending by category</div>
          <DonutChart rows={breakdown} />
        </div>
      </div>

      <div className="grid-2-even">
        <div className="panel">
          <div className="panel-title">Budgets</div>
          {topBudgets.length === 0 ? (
            <div className="empty-state">No budgets set yet.</div>
          ) : (
            <div className="budget-list">
              {topBudgets.map((b) => {
                const pct = b.amountCents > 0 ? (b.spentCents / b.amountCents) * 100 : 0;
                return (
                  <div className="budget-row-mini" key={b.categoryId}>
                    <div className="line">
                      <span className="who">
                        <span className="color-dot" style={{ background: b.categoryColor }} />
                        {b.categoryName}
                      </span>
                      <span className="nums" title={`Spent ${CADENCE_PERIOD[b.cadence]}`}>
                        {fmtMoney(b.spentCents)} / {fmtMoney(b.amountCents)}
                        <span className="cadence-tag">{CADENCE_SHORT[b.cadence]}</span>
                      </span>
                    </div>
                    <ProgressBar pct={pct} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="panel">
          <div className="panel-title">Recent transactions</div>
          {recent.length === 0 ? (
            <div className="empty-state">
              Nothing recorded in {periodLabel(period)}.
              <br />
              <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
                <PlusIcon /> Add your first transaction
              </button>
            </div>
          ) : (
            /* recent-table: ≤860px CSS restacks rows (note hidden — glance list) */
            <table className="table recent-table">
              <tbody>
                {recent.map((t) => (
                  <tr key={t.id}>
                    <td style={{ whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>
                      {dateLabel(t.date)}
                    </td>
                    <td>
                      <span className="cat-chip">
                        <span
                          className="color-dot"
                          style={{ background: t.categoryColor ?? '#64748b' }}
                        />
                        <span>{t.categoryName ?? 'Uncategorized'}</span>
                      </span>
                    </td>
                    <td className="note-cell">{t.note}</td>
                    <td className={`num amount-${t.type}`}>{fmtSigned(t.amountCents, t.type)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showAdd && (
        <TransactionModal
          initial={null}
          categories={categories}
          accounts={accounts}
          defaultMonth={budgetMonth}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            void load();
            onDataChanged();
          }}
        />
      )}
      {showTransfer && (
        <TransferModal
          initial={null}
          accounts={accounts}
          onClose={() => setShowTransfer(false)}
          onSaved={() => {
            void load();
            onDataChanged();
          }}
        />
      )}
    </div>
  );
}
