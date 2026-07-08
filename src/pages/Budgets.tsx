import { useCallback, useEffect, useState } from 'react';
import type { Budget, BudgetCadence } from '../../shared/types';
import { api } from '../api';
import { toast } from '../components/feedback';
import { MoneyInput } from '../components/MoneyInput';
import { ProgressBar } from '../components/ProgressBar';
import {
  CADENCE_LABEL,
  CADENCE_PERIOD,
  centsToInput,
  cleanError,
  fmtMoney,
  parseAmountToCents,
} from '../format';

const CADENCES: BudgetCadence[] = ['week', 'month', 'year'];

// A row whose local edits differ from what's saved on the server.
interface PendingRow {
  row: Budget;
  cadence: BudgetCadence;
  cents: number; // 0 means "remove this budget"
  invalid: boolean; // amount typed but not a valid number
}

export function Budgets() {
  const [rows, setRows] = useState<Budget[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  // categoryId -> in-progress amount / cadence. Edits stay local until Save.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [cadenceDrafts, setCadenceDrafts] = useState<Record<number, BudgetCadence>>({});

  const load = useCallback(async () => {
    try {
      setRows(await api.budgets.list());
      setDrafts({});
      setCadenceDrafts({});
      setLoaded(true);
    } catch (err) {
      toast.error(cleanError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Which rows have unsaved edits (and what to write for each).
  const pending: PendingRow[] = [];
  for (const row of rows) {
    const amtStr = drafts[row.categoryId];
    const touchedAmt = amtStr !== undefined;
    const touchedCad = cadenceDrafts[row.categoryId] !== undefined;
    if (!touchedAmt && !touchedCad) continue;

    const cadence = cadenceDrafts[row.categoryId] ?? row.cadence;
    let cents = row.amountCents;
    let invalid = false;
    if (touchedAmt) {
      const t = amtStr.trim();
      if (t === '') {
        cents = 0;
      } else {
        const parsed = parseAmountToCents(t);
        if (parsed === null) invalid = true;
        else cents = parsed;
      }
    }
    if (invalid) {
      pending.push({ row, cadence, cents: row.amountCents, invalid: true });
      continue;
    }
    // Cadence only matters when there's an amount; a 0 budget doesn't exist.
    const changed = cents !== row.amountCents || (cents > 0 && cadence !== row.cadence);
    if (changed) pending.push({ row, cadence, cents, invalid: false });
  }
  const dirty = pending.length > 0;
  const invalidRow = pending.find((p) => p.invalid);

  // Warn before a full-page unload (refresh / close tab) with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const save = async () => {
    if (invalidRow) {
      toast.error(`Enter a valid amount for ${invalidRow.row.categoryName}, or clear it.`);
      return;
    }
    const toSave = pending.filter((p) => !p.invalid);
    if (toSave.length === 0) return;
    setSaving(true);
    try {
      await Promise.all(toSave.map((p) => api.budgets.upsert(p.row.categoryId, p.cadence, p.cents)));
      await load();
      toast.success(`${toSave.length} budget${toSave.length === 1 ? '' : 's'} saved`);
    } catch (err) {
      toast.error(cleanError(err));
    } finally {
      setSaving(false);
    }
  };

  const active = rows.filter((r) => r.amountCents > 0);
  const overCount = active.filter((r) => r.spentCents > r.amountCents).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Budgets</h1>
          <div className="page-sub">
            {active.length === 0
              ? 'Set a recurring limit per category — weekly, monthly, or yearly'
              : `${active.length} budget${active.length === 1 ? '' : 's'} set` +
                (overCount > 0 ? ` · ${overCount} over limit` : ' · all within limit')}
          </div>
        </div>
        <div className="head-actions">
          {dirty && <span className="unsaved-hint">● Unsaved changes</span>}
          <button
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={saving || !dirty}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      {loaded && rows.length === 0 ? (
        <div className="empty-state">
          No expense categories yet — create some on the Categories page first.
        </div>
      ) : (
        <div className="panel" style={{ padding: '6px 8px' }}>
          {/* budgets-table: ≤860px CSS restacks each row into an editable card */}
          <table className="table budgets-table">
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ width: 120 }}>Cadence</th>
                <th style={{ width: 140 }}>Budget</th>
                <th className="num" style={{ textAlign: 'right' }}>Spent</th>
                <th className="num" style={{ textAlign: 'right' }}>Remaining</th>
                <th style={{ width: '24%' }}>Progress</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const cadence = cadenceDrafts[b.categoryId] ?? b.cadence;
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
                      <select
                        className="budget-cadence"
                        aria-label={`Budget cadence for ${b.categoryName}`}
                        value={cadence}
                        onChange={(e) =>
                          setCadenceDrafts((d) => ({
                            ...d,
                            [b.categoryId]: e.target.value as BudgetCadence,
                          }))
                        }
                      >
                        {CADENCES.map((c) => (
                          <option key={c} value={c}>
                            {CADENCE_LABEL[c]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <MoneyInput
                        className="budget-money"
                        ariaLabel={`Budget for ${b.categoryName}`}
                        placeholder="—"
                        value={drafts[b.categoryId] ?? centsToInput(b.amountCents)}
                        onChange={(clean) =>
                          setDrafts((d) => ({ ...d, [b.categoryId]: clean }))
                        }
                        onEnter={() => void save()}
                      />
                    </td>
                    <td className="num" title={b.amountCents > 0 ? `Spent ${CADENCE_PERIOD[b.cadence]}` : undefined}>
                      {b.amountCents > 0 ? (
                        fmtMoney(b.spentCents)
                      ) : (
                        <span style={{ color: 'var(--text-faint)' }}>—</span>
                      )}
                    </td>
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
