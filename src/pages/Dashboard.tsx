import { useCallback, useEffect, useState } from 'react';
import type {
  BreakdownRow,
  Budget,
  Category,
  MonthlySummary,
  Transaction,
} from '../../shared/types';
import { api } from '../api';
import { DonutChart } from '../components/DonutChart';
import { PlusIcon } from '../components/Icons';
import { MonthPicker } from '../components/MonthPicker';
import { ProgressBar } from '../components/ProgressBar';
import { TransactionModal } from '../components/TransactionModal';
import { TrendChart } from '../components/TrendChart';
import { cleanError, dateLabel, fmtMoney, fmtSigned, monthLabel } from '../format';

interface DashboardData {
  summary: MonthlySummary;
  trend: MonthlySummary[];
  breakdown: BreakdownRow[];
  budgets: Budget[];
  recent: Transaction[];
}

export function Dashboard({
  month,
  setMonth,
  categories,
  onDataChanged,
}: {
  month: string;
  setMonth: (m: string) => void;
  categories: Category[];
  onDataChanged: () => void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const [summary, trend, breakdown, budgets, txs] = await Promise.all([
        api.reports.summary(month),
        api.reports.trend(month, 6),
        api.reports.breakdown(month, 'expense'),
        api.budgets.list(month),
        api.transactions.list({ month }),
      ]);
      setData({ summary, trend, breakdown, budgets, recent: txs.slice(0, 8) });
    } catch (err) {
      alert(cleanError(err));
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <div className="loading">Loading…</div>;

  const { summary, trend, breakdown, budgets, recent } = data;
  const net = summary.incomeCents - summary.expenseCents;
  const activeBudgets = budgets.filter((b) => b.amountCents > 0);
  const budgetTotal = activeBudgets.reduce((s, b) => s + b.amountCents, 0);
  const budgetSpent = activeBudgets.reduce((s, b) => s + b.spentCents, 0);
  const budgetPct = budgetTotal > 0 ? Math.round((budgetSpent / budgetTotal) * 100) : 0;
  const savingsRate = summary.incomeCents > 0 ? Math.round((net / summary.incomeCents) * 100) : null;
  const topBudgets = [...activeBudgets].sort((a, b) => b.amountCents - a.amountCents).slice(0, 5);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-sub">{monthLabel(month)} overview</div>
        </div>
        <div className="head-actions">
          <MonthPicker value={month} onChange={setMonth} />
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
          <div className="stat-label">Budget used</div>
          <div className={`stat-value ${budgetPct >= 100 ? 'red' : ''}`}>
            {budgetTotal > 0 ? `${budgetPct}%` : '—'}
          </div>
          <div className="stat-sub">
            {budgetTotal > 0
              ? `${fmtMoney(budgetSpent)} of ${fmtMoney(budgetTotal)}`
              : 'No budgets set for this month'}
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
            <div className="empty-state">No budgets for {monthLabel(month)} yet.</div>
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
                      <span className="nums">
                        {fmtMoney(b.spentCents)} / {fmtMoney(b.amountCents)}
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
              Nothing recorded in {monthLabel(month)}.
              <br />
              <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
                <PlusIcon /> Add your first transaction
              </button>
            </div>
          ) : (
            <table className="table">
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
          defaultMonth={month}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            void load();
            onDataChanged();
          }}
        />
      )}
    </div>
  );
}
