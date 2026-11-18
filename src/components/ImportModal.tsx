import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import type { Account, Category, ImportRule, Transaction, TxType } from '../../shared/types';
import { isArchived } from '../accounts';
import { api } from '../api';
import {
  buildRows,
  DATE_FORMAT_LABEL,
  detectDateFormat,
  findDuplicates,
  findHeaderRow,
  guessColumns,
  matchRule,
  parseCsv,
  suggestKeyword,
} from '../csvImport';
import type { ColumnMap, DateFormat, StatementRow } from '../csvImport';
import { cleanError, dateLabel, fmtMoney, fmtSigned } from '../format';
import { addDays } from '../schedule';
import { toast } from './feedback';
import { CheckIcon, PlusIcon, UploadIcon, XIcon } from './Icons';
import { Modal } from './Modal';

// Importing a bank statement exported as CSV (Transactions → Import), in
// three steps: pick the account and file, check which column is which, then
// review every line (category, rules, likely duplicates) before anything is
// saved. The file never leaves the browser: POST /import gets only the lines
// that are ticked. Parsing lives in src/csvImport.ts.

const MAX_ROWS = 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

type Step = 'file' | 'map' | 'review';

// What the user changed on a line; anything unset follows the defaults.
interface Choice {
  include?: boolean;
  categoryId?: string;
}

interface Line {
  index: number;
  row: StatementRow & { date: string; type: TxType };
  rule: ImportRule | undefined;
  dupe: Transaction | undefined;
  cardCredit: boolean;
  include: boolean;
  categoryId: string;
}

function headersFor(table: string[][], headerRow: number): string[] {
  const width = Math.max(0, ...table.slice(0, 50).map((r) => r.length));
  return Array.from({ length: width }, (_, j) => (headerRow >= 0 ? table[headerRow][j] : '') || `Column ${j + 1}`);
}

export function ImportModal({
  accounts,
  categories,
  onClose,
  onSaved,
}: {
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const targets = accounts.filter((a) => (a.type === 'debit' || a.type === 'credit') && !isArchived(a));
  const [step, setStep] = useState<Step>('file');
  const [accountId, setAccountId] = useState(() => String(targets[0]?.id ?? ''));
  const account = accounts.find((a) => String(a.id) === accountId);
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<string[][]>([]);
  const [headerRow, setHeaderRow] = useState(-1);
  const [map, setMap] = useState<ColumnMap | null>(null);
  const [dateFormat, setDateFormat] = useState<DateFormat>('ymd');
  const [rules, setRules] = useState<ImportRule[]>([]);
  const [existing, setExisting] = useState<Transaction[]>([]);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [ruleForm, setRuleForm] = useState({ keyword: '', categoryId: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.imports
      .rules()
      .then(setRules)
      .catch(() => {
        /* no rules shown; importing still works */
      });
  }, []);

  // Re-guesses the columns for a header row choice.
  const applyHeader = (rows: string[][], header: number) => {
    const data = rows.slice(header + 1);
    const guess = guessColumns(headersFor(rows, header), data, account?.type === 'credit' ? 'credit' : 'debit');
    setHeaderRow(header);
    setMap(guess);
    setDateFormat(detectDateFormat(data.map((r) => (guess.date >= 0 ? r[guess.date] ?? '' : ''))) ?? 'ymd');
    setChoices({});
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // the same file can be picked again
    if (!file) return;
    setError('');
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is over 2 MB. Export a shorter date range.');
      return;
    }
    const rows = parseCsv(await file.text());
    if (rows.length === 0) {
      setError("That file has no rows. Check that it's a CSV export.");
      return;
    }
    setTable(rows);
    setFileName(file.name);
    applyHeader(rows, findHeaderRow(rows));
    setStep('map');
  };

  const headers = useMemo(() => headersFor(table, headerRow), [table, headerRow]);
  const statement = useMemo(
    () => (map ? buildRows(table.slice(headerRow + 1), headerRow + 2, map, dateFormat) : []),
    [table, headerRow, map, dateFormat]
  );
  const readable = statement.filter((r) => !r.error);
  const failed = statement.filter((r) => r.error);
  const dupes = useMemo(() => findDuplicates(statement, existing), [statement, existing]);

  const isCard = account?.type === 'credit';
  const lines: Line[] = statement.flatMap((r, index) => {
    if (r.error || r.date === null || r.type === null) return [];
    const row = r as Line['row'];
    const rule = matchRule(r.description, r.type, rules);
    const dupe = dupes.get(index);
    // Money in on a card is usually a payment already recorded as a transfer.
    const cardCredit = isCard && r.type === 'income';
    const choice = choices[index] ?? {};
    return [
      {
        index,
        row,
        rule,
        dupe,
        cardCredit,
        include: choice.include ?? (!dupe && !cardCredit),
        categoryId: choice.categoryId ?? (rule ? String(rule.categoryId) : ''),
      },
    ];
  });
  const chosen = lines.filter((l) => l.include);
  const total = (type: TxType) => chosen.filter((l) => l.row.type === type).reduce((s, l) => s + l.row.amountCents, 0);

  const choose = (index: number, patch: Choice) => setChoices((c) => ({ ...c, [index]: { ...c[index], ...patch } }));
  const tickAll = (include: boolean) =>
    setChoices((c) => Object.fromEntries(lines.map((l) => [l.index, { ...c[l.index], include }])));

  const toReview = async () => {
    const dates = readable.map((r) => r.date as string).sort();
    if (dates.length === 0) {
      setError('No lines can be read with these columns. Check the date and amount columns.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // What's already recorded around these dates, to spot duplicates.
      setExisting(
        await api.transactions.list({
          accountId: Number(accountId),
          from: addDays(dates[0], -3),
          to: addDays(dates[dates.length - 1], 3),
        })
      );
      setChoices({});
      setStep('review');
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (chosen.length === 0) return;
    if (chosen.length > MAX_ROWS) {
      setError(`Import up to ${MAX_ROWS} lines at a time; ${chosen.length} are ticked.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api.imports.run({
        accountId: Number(accountId),
        rows: chosen.map((l) => ({
          date: l.row.date,
          amountCents: l.row.amountCents,
          type: l.row.type,
          categoryId: l.categoryId ? Number(l.categoryId) : null,
          note: l.row.description,
        })),
      });
      toast.success(`Imported ${res.imported} transaction${res.imported === 1 ? '' : 's'} into ${account?.name ?? 'the account'}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setBusy(false);
    }
  };

  const addRule = async () => {
    const keyword = ruleForm.keyword.trim();
    if (keyword.length < 2 || !ruleForm.categoryId) {
      setError('A rule needs a word to look for (at least 2 letters) and a category.');
      return;
    }
    try {
      const saved = await api.imports.saveRule(keyword, Number(ruleForm.categoryId));
      setRules((list) => [...list.filter((r) => r.id !== saved.id), saved].sort((a, b) => a.keyword.localeCompare(b.keyword)));
      setRuleForm({ keyword: '', categoryId: '' });
      setError('');
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const removeRule = async (id: number) => {
    try {
      await api.imports.removeRule(id);
      setRules((list) => list.filter((r) => r.id !== id));
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const columnSelect = (id: string, label: string, value: number, onChange: (j: number) => void) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        <option value={-1}>Not in this file</option>
        {headers.map((h, j) => (
          <option key={j} value={j}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );
  const setCol = (patch: Partial<ColumnMap>) => map && setMap({ ...map, ...patch });
  const categoryOptions = (type: TxType) =>
    categories
      .filter((c) => c.type === type)
      .map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ));

  return (
    <Modal title="Import a bank statement" onClose={onClose} wide={step !== 'file'}>
      {step === 'file' && (
        <div className="form-grid">
          {targets.length === 0 ? (
            <div className="field-hint">Add a bank account or credit card on the Accounts page first.</div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="imp-account">Account the statement is for</label>
                <select id="imp-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {targets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.type === 'credit' ? 'card' : 'debit'})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Statement file</label>
                <label className="btn import-file">
                  <UploadIcon /> Choose a CSV file
                  <input type="file" accept=".csv,text/csv" hidden onChange={(e) => void onFile(e)} />
                </label>
              </div>
            </>
          )}
          <div className="field-hint">
            Download a CSV from your bank's online banking (often under Statements or Transaction history). The file
            stays on your device: you check every line first, and only the ones you tick are saved. PDF statements
            can't be read here.
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === 'map' && map && (
        <div className="form-grid">
          <div className="field-hint">
            {fileName} · {table.length} rows. Check which column is which; the preview updates as you go.
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor="imp-header">Column names</label>
              <select id="imp-header" value={headerRow} onChange={(e) => applyHeader(table, Number(e.target.value))}>
                <option value={-1}>None: every row is a line</option>
                {table.slice(0, 10).map((r, i) => (
                  <option key={i} value={i}>
                    Row {i + 1}: {r.filter(Boolean).slice(0, 4).join(', ').slice(0, 50)}
                  </option>
                ))}
              </select>
            </div>
            {columnSelect('imp-desc', 'Description', map.description, (j) => setCol({ description: j }))}
          </div>
          <div className="form-row">
            {columnSelect('imp-date', 'Date', map.date, (j) => setCol({ date: j }))}
            <div className="field">
              <label htmlFor="imp-datefmt">Dates are written as</label>
              <select id="imp-datefmt" value={dateFormat} onChange={(e) => setDateFormat(e.target.value as DateFormat)}>
                {(Object.keys(DATE_FORMAT_LABEL) as DateFormat[]).map((f) => (
                  <option key={f} value={f}>
                    {DATE_FORMAT_LABEL[f]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Amounts</label>
            <div className="segmented" role="group" aria-label="How amounts are laid out">
              <button type="button" className={map.mode === 'signed' ? 'active-account' : ''} onClick={() => setCol({ mode: 'signed' })}>
                One column
              </button>
              <button type="button" className={map.mode === 'split' ? 'active-account' : ''} onClick={() => setCol({ mode: 'split' })}>
                Money out and in apart
              </button>
            </div>
          </div>
          {map.mode === 'signed' ? (
            <div className="form-row">
              {columnSelect('imp-amount', 'Amount', map.amount, (j) => setCol({ amount: j }))}
              <div className="field">
                <label htmlFor="imp-sign">Money out is shown as</label>
                <select id="imp-sign" value={map.outIsNegative ? 'neg' : 'pos'} onChange={(e) => setCol({ outIsNegative: e.target.value === 'neg' })}>
                  <option value="neg">Negative amounts (−250.00)</option>
                  <option value="pos">Positive amounts (card statements)</option>
                </select>
              </div>
            </div>
          ) : (
            <div className="form-row">
              {columnSelect('imp-out', 'Money out (debit, withdrawal)', map.debit, (j) => setCol({ debit: j }))}
              {columnSelect('imp-in', 'Money in (credit, deposit)', map.credit, (j) => setCol({ credit: j }))}
            </div>
          )}
          <div className="import-preview">
            <table className="table import-table">
              <tbody>
                {statement.slice(0, 6).map((r) => (
                  <tr key={r.line}>
                    <td className="import-date">{r.date ? dateLabel(r.date) : '—'}</td>
                    <td>{r.description || '—'}</td>
                    <td className={`num ${r.type === 'income' ? 'amount-income' : r.type ? 'amount-expense' : ''}`}>
                      {r.error ? <span className="sched-warn">{r.error}</span> : fmtSigned(r.amountCents, r.type ?? 'expense')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="field-hint">
            {readable.length} line{readable.length === 1 ? '' : 's'} read
            {failed.length > 0 && `, ${failed.length} can't be (totals and notes usually; listed on the next step)`}.
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setStep('file')}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void toReview()} disabled={busy || readable.length === 0}>
              <CheckIcon /> Review {readable.length} line{readable.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="form-grid">
          <div className="import-summary">
            <span>
              <strong>{chosen.length}</strong> of {lines.length} ticked · {fmtMoney(total('expense'))} out · {fmtMoney(total('income'))} in
              {' · '}into {account?.name}
            </span>
            <span>
              <button type="button" className="link-button" onClick={() => tickAll(true)}>
                Tick all
              </button>
              {' · '}
              <button type="button" className="link-button" onClick={() => tickAll(false)}>
                Untick all
              </button>
            </span>
          </div>
          <div className="import-table-wrap">
            <table className="table import-table">
              <thead>
                <tr>
                  <th aria-label="Import" />
                  <th>Date</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.index} className={l.include ? '' : 'import-off'}>
                    <td>
                      <input
                        type="checkbox"
                        checked={l.include}
                        onChange={(e) => choose(l.index, { include: e.target.checked })}
                        aria-label={`Import row ${l.row.line}`}
                      />
                    </td>
                    <td className="import-date">{dateLabel(l.row.date)}</td>
                    <td>
                      <div>{l.row.description || '—'}</div>
                      {(l.dupe || l.cardCredit || l.rule) && (
                        <div className="import-tags">
                          {l.dupe && (
                            <span className="due-tag due-soon" title="Same amount within 3 days on this account">
                              Already recorded? {dateLabel(l.dupe.date)}
                              {l.dupe.note ? ` · ${l.dupe.note.slice(0, 30)}` : ''}
                            </span>
                          )}
                          {l.cardCredit && (
                            <span className="due-tag" title="Card payments are usually recorded as a transfer from your bank">
                              Money in on a card: a payment you've recorded?
                            </span>
                          )}
                          {l.rule && choices[l.index]?.categoryId === undefined && (
                            <span className="due-tag due-ok">Rule: {l.rule.keyword}</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <select
                        value={l.categoryId}
                        onChange={(e) => choose(l.index, { categoryId: e.target.value })}
                        aria-label={`Category for row ${l.row.line}`}
                      >
                        <option value="">Uncategorized</option>
                        {categoryOptions(l.row.type)}
                      </select>
                      <button
                        type="button"
                        className="link-button import-rule-link"
                        onClick={() => {
                          setRuleForm({ keyword: suggestKeyword(l.row.description), categoryId: l.categoryId });
                          document.getElementById('imp-rule-keyword')?.focus();
                        }}
                      >
                        + Make a rule
                      </button>
                    </td>
                    <td className={`num ${l.row.type === 'income' ? 'amount-income' : 'amount-expense'}`}>
                      {fmtSigned(l.row.amountCents, l.row.type)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {failed.length > 0 && (
            <details className="import-failed">
              <summary>
                {failed.length} row{failed.length === 1 ? '' : 's'} can't be imported
              </summary>
              <ul>
                {failed.slice(0, 50).map((r) => (
                  <li key={r.line}>
                    Row {r.line}: {r.error}
                    {r.description ? ` (${r.description.slice(0, 40)})` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="import-rules">
            <div className="import-rules-title">
              Rules: a line whose description contains a word goes in a category, now and in later imports.
            </div>
            {rules.length > 0 && (
              <div className="import-rule-list">
                {rules.map((r) => (
                  <span className="cat-chip" key={r.id}>
                    <span>“{r.keyword}” →</span>
                    <span className="color-dot" style={{ background: r.categoryColor }} />
                    <span>{r.categoryName}</span>
                    <button type="button" className="btn-icon import-rule-x" title="Remove this rule" onClick={() => void removeRule(r.id)}>
                      <XIcon />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="import-rule-form">
              <input
                id="imp-rule-keyword"
                type="text"
                placeholder="Description contains, e.g. jollibee"
                value={ruleForm.keyword}
                maxLength={60}
                onChange={(e) => setRuleForm({ ...ruleForm, keyword: e.target.value })}
              />
              <select
                aria-label="Category for the rule"
                value={ruleForm.categoryId}
                onChange={(e) => setRuleForm({ ...ruleForm, categoryId: e.target.value })}
              >
                <option value="">Category…</option>
                <optgroup label="Expense">{categoryOptions('expense')}</optgroup>
                <optgroup label="Income">{categoryOptions('income')}</optgroup>
              </select>
              <button type="button" className="btn" onClick={() => void addRule()}>
                <PlusIcon /> Add rule
              </button>
            </div>
          </div>

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setStep('map')}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={busy || chosen.length === 0}>
              <CheckIcon /> {busy ? 'Importing…' : `Import ${chosen.length} transaction${chosen.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
