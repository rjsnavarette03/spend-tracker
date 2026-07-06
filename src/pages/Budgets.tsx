import { useCallback, useEffect, useState } from 'react';
import type { Budget } from '../../shared/types';
import { api } from '../api';
import { CopyIcon } from '../components/Icons';
import { MonthPicker } from '../components/MonthPicker';
import { ProgressBar } from '../components/ProgressBar';
import {
  centsToInput,
  cleanError,
  fmtMoney,
  monthLabel,
  parseAmountToCents,
} from '../format';

export function Budgets({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const [rows, setRows] = useState<Budget[]>([]);
  const [loaded, setLoaded] = useState(false);
  // categoryId -> in-progress input value while the user is typing
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await api.budgets.list(month));
      setDrafts({});
      setLoaded(true);
    } catch (err) {
      alert(cleanError(err));
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  const commit = async (b: Budget) => {
    const draft = drafts[b.categoryId];
    if (draft === undefined) return;
    const trimmed = draft.trim();
    const cents = trimmed === '' ? 0 : parseAmountToCents(trimmed);
    if (cents === null) {
      alert('Enter a valid amount, or leave empty to remove the budget.');
      return;
    }
    if (cents === b.amountCents) {
      setDrafts((d) => {
        const next = { ...d };
        delete next[b.categoryId];
        return next;
      });
      return;
    }
    try {
      await api.budgets.upsert(b.categoryId, month, cents);
      await load();
    } catch (err) {
      alert(cleanError(err));
    }
  };

  const copyPrevious = async () => {
    try {
      const copied = await api.budgets.copyFromPrevious(month);
      setNotice(copied > 0 ? `Copied ${copied} budget${copied === 1 ? '' : 's'}` : 'Nothing to copy');
      setTimeout(() => setNotice(''), 4000);
      await load();
    } catch (err) {
      alert(cleanError(err));
    }
  };

  const active = rows.filter((r) => r.amountCents > 0);
  const totalBudget = active.reduce((s, r) => s + r.amountCents, 0);
  const totalSpent = active.reduce((s, r) => s + r.spentCents, 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Budgets</h1>
          <div className="page-sub">
            {totalBudget > 0
              ? `${fmtMoney(totalSpent)} spent of ${fmtMoney(totalBudget)} budgeted · ${fmtMoney(Math.max(0, totalBudget - totalSpent))} left`
              : `Set monthly limits per category for ${monthLabel(month)}`}
          </div>
        </div>
        <div className="head-actions">
          {notice && <span className="notice">{notice}</span>}
          <MonthPicker value={month} onChange={setMonth} />
          <button className="btn" onClick={copyPrevious}>
            <CopyIcon /> Copy last month
          </button>
        </div>
      </div>

      {loaded && rows.length === 0 ? (
        <div className="empty-state">
          No expense categories yet — create some on the Categories page first.
        </div>
      ) : (
        <div className="panel" style={{ padding: '6px 8px' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ width: 140 }}>Monthly budget</th>
                <th className="num" style={{ textAlign: 'right' }}>Spent</th>
                <th className="num" style={{ textAlign: 'right' }}>Remaining</th>
                <th style={{ width: '28%' }}>Progress</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const pct = b.amountCents > 0 ? (b.spentCents / b.amountCents) * 100 : 0;
                const remaining = b.amountCents - b.spentCents;
                return (
                  <tr key={b.categoryId}>
                    <td>
                      <span className="cat-chip">
                        <span className="color-dot" style={{ background: b.categoryColor }} />
                        <span>{b.categoryName}</span>
                      </span>
                    </td>
                    <td>
                      <input
                        className="budget-input"
                        type="text"
                        inputMode="decimal"
                        placeholder="—"
                        value={drafts[b.categoryId] ?? centsToInput(b.amountCents)}
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [b.categoryId]: e.target.value }))
                        }
                        onBlur={() => void commit(b)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </td>
                    <td className="num">{fmtMoney(b.spentCents)}</td>
                    <td className="num">
                      {b.amountCents > 0 ? (
                        <span className={remaining < 0 ? 'amount-expense' : ''}>
                          {fmtMoney(remaining)}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-faint)' }}>—</span>
                      )}
                    </td>
                    <td>
                      {b.amountCents > 0 ? (
                        <ProgressBar pct={pct} />
                      ) : (
                        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>No budget</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
