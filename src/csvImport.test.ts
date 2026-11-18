import { describe, expect, it } from 'vitest';
import type { ImportRule, Transaction } from '../shared/types';
import {
  buildRows,
  detectDateFormat,
  findDuplicates,
  findHeaderRow,
  guessColumns,
  matchRule,
  parseAmount,
  parseCsv,
  parseDate,
  suggestKeyword,
} from './csvImport';
import type { ColumnMap, StatementRow } from './csvImport';

// Bank statement import: reading the CSV and preparing lines to review.

describe('parseCsv', () => {
  it('reads quoted cells, doubled quotes, CRLF, a BOM and blank lines', () => {
    const text = '﻿Date,Description,Amount\r\n2026-11-01,"Jollibee, SM North",-250.00\r\n\r\n2026-11-02,"He said ""hi""",100\n';
    expect(parseCsv(text)).toEqual([
      ['Date', 'Description', 'Amount'],
      ['2026-11-01', 'Jollibee, SM North', '-250.00'],
      ['2026-11-02', 'He said "hi"', '100'],
    ]);
  });

  it('keeps a line break inside quotes and detects semicolons and tabs', () => {
    expect(parseCsv('a;b\n"x\ny";2')).toEqual([['a', 'b'], ['x\ny', '2']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('parseAmount', () => {
  it('reads the usual ways banks write money', () => {
    expect(['₱1,234.56', 'PHP 50', '-50', '50-', '(1,234.56)', '1,234.56 DR', '99.50 CR', '12,50', '1.234,56', '1,234,567'].map(parseAmount)).toEqual([
      123456, 5000, -5000, -5000, -123456, -123456, 9950, 1250, 123456, 123456700,
    ]);
  });

  it('refuses dates, times, words and empty cells', () => {
    expect(['', '11/14/2026', '10:30', 'Jollibee', '1.2.3', '-'].map(parseAmount)).toEqual([null, null, null, null, null, null]);
  });
});

describe('parseDate and detectDateFormat', () => {
  it('reads each format into YYYY-MM-DD, ignoring a time after it', () => {
    expect(parseDate('2026-11-14 10:23:00', 'ymd')).toBe('2026-11-14');
    expect(parseDate('2026/11/14', 'ymd')).toBe('2026-11-14');
    expect(parseDate('11/14/2026', 'mdy')).toBe('2026-11-14');
    expect(parseDate('14/11/26', 'dmy')).toBe('2026-11-14');
    expect(parseDate('Nov 14, 2026', 'text')).toBe('2026-11-14');
    expect(parseDate('14-Nov-2026', 'text')).toBe('2026-11-14');
    expect(parseDate('September 3rd 2026', 'text')).toBe('2026-09-03');
  });

  it('refuses dates that do not exist or do not fit the format', () => {
    expect(parseDate('2026-02-30', 'ymd')).toBeNull();
    expect(parseDate('14/11/2026', 'mdy')).toBeNull();
    expect(parseDate('11/14/2026', 'ymd')).toBeNull();
    expect(parseDate('Total', 'text')).toBeNull();
  });

  it('picks the format that reads the most cells, month first on a tie', () => {
    expect(detectDateFormat(['2026-11-01', '2026-11-02', 'Total'])).toBe('ymd');
    expect(detectDateFormat(['01/11/2026', '25/11/2026'])).toBe('dmy');
    expect(detectDateFormat(['11/01/2026', '11/25/2026'])).toBe('mdy');
    expect(detectDateFormat(['03/04/2026'])).toBe('mdy');
    expect(detectDateFormat(['Nov 1, 2026'])).toBe('text');
    expect(detectDateFormat(['hello'])).toBeNull();
  });
});

describe('findHeaderRow and guessColumns', () => {
  const statement = [
    ['UnionBank Statement'],
    ['Account', '1234-5678'],
    ['Transaction Date', 'Posting Date', 'Description', 'Withdrawal', 'Deposit', 'Running Balance'],
    ['11/01/2026', '11/02/2026', 'JOLLIBEE SM NORTH', '250.00', '', '9,750.00'],
    ['11/03/2026', '11/03/2026', 'SALARY', '', '30,000.00', '39,750.00'],
  ];

  it('skips the lines about the account to find the column names', () => {
    expect(findHeaderRow(statement)).toBe(2);
    expect(findHeaderRow([['2026-11-01', 'Coffee', '-120']])).toBe(-1);
  });

  it('maps named columns, preferring the transaction date and leaving the balance out', () => {
    expect(guessColumns(statement[2], statement.slice(3), 'debit')).toEqual({
      date: 0, description: 2, mode: 'split', amount: -1, debit: 3, credit: 4, outIsNegative: true,
    });
  });

  it('falls back to what the cells look like when there are no names', () => {
    const rows = [['2026-11-01', 'Coffee at the corner shop', '-120.00'], ['2026-11-02', 'Groceries for the week', '-1,500.00']];
    expect(guessColumns(['Column 1', 'Column 2', 'Column 3'], rows, 'credit')).toMatchObject({
      date: 0, description: 1, mode: 'signed', amount: 2, outIsNegative: false,
    });
  });
});

describe('buildRows', () => {
  const signed: ColumnMap = { date: 0, description: 1, mode: 'signed', amount: 2, debit: -1, credit: -1, outIsNegative: true };

  it('turns lines into money out and money in, with the reason a line cannot be read', () => {
    const rows = buildRows(
      [['2026-11-01', '  JOLLIBEE   SM ', '-250.00'], ['2026-11-02', 'SALARY', '30000'], ['Total', '', '29,750'], ['2026-11-03', 'Fee', '']],
      4,
      signed,
      'ymd'
    );
    expect(rows).toEqual([
      { line: 4, date: '2026-11-01', description: 'JOLLIBEE SM', amountCents: 25000, type: 'expense', error: null },
      { line: 5, date: '2026-11-02', description: 'SALARY', amountCents: 3000000, type: 'income', error: null },
      { line: 6, date: null, description: '', amountCents: 2975000, type: null, error: 'Can\'t read the date "Total"' },
      { line: 7, date: '2026-11-03', description: 'Fee', amountCents: 0, type: null, error: 'No amount' },
    ]);
  });

  it('flips the sign for card statements and reads separate columns', () => {
    const card = buildRows([['2026-11-01', 'Netflix', '549.00']], 2, { ...signed, outIsNegative: false }, 'ymd');
    expect(card[0]).toMatchObject({ type: 'expense', amountCents: 54900 });
    const split: ColumnMap = { ...signed, mode: 'split', amount: -1, debit: 2, credit: 3 };
    const out = buildRows([['2026-11-01', 'A', '10', ''], ['2026-11-01', 'B', '', '20'], ['2026-11-01', 'C', '1', '2']], 2, split, 'ymd');
    expect(out.map((r) => [r.type, r.amountCents, r.error])).toEqual([
      ['expense', 1000, null],
      ['income', 2000, null],
      [null, 0, 'Has both money out and money in'],
    ]);
  });
});

describe('rules and duplicates', () => {
  const rule = (id: number, keyword: string, categoryType: 'expense' | 'income' = 'expense'): ImportRule => ({
    id, keyword, categoryId: id, categoryName: `Cat ${id}`, categoryColor: '#888888', categoryType,
  });

  it('applies the longest matching keyword of the line type', () => {
    const rules = [rule(1, 'sm'), rule(2, 'sm supermarket'), rule(3, 'salary', 'income')];
    expect(matchRule('SM SUPERMARKET NORTH', 'expense', rules)?.id).toBe(2);
    expect(matchRule('SM Store', 'expense', rules)?.id).toBe(1);
    expect(matchRule('SALARY NOV', 'expense', rules)).toBeUndefined();
    expect(matchRule('SALARY NOV', 'income', rules)?.id).toBe(3);
  });

  it('suggests a keyword without reference numbers', () => {
    expect(suggestKeyword('JOLLIBEE SM NORTH 123456')).toBe('jollibee');
    expect(suggestKeyword('SM SUPERMARKET 0098')).toBe('sm supermarket');
    expect(suggestKeyword('POS 123456789')).toBe('pos');
    expect(suggestKeyword('')).toBe('');
  });

  const tx = (id: number, date: string, amountCents: number, splitGroup: number | null = null): Transaction => ({
    id, amountCents, type: 'expense', categoryId: null, accountId: 1, date, time: null, note: '', splitGroup,
    categoryName: null, categoryColor: null, accountName: null, accountColor: null,
  });
  const line = (date: string, amountCents: number): StatementRow => ({ line: 1, date, description: '', amountCents, type: 'expense', error: null });

  it('matches each recorded transaction once, the closest date first, within 3 days', () => {
    const rows = [line('2026-11-05', 25000), line('2026-11-05', 25000), line('2026-11-10', 9900), line('2026-11-20', 500)];
    const existing = [tx(1, '2026-11-03', 25000), tx(2, '2026-11-05', 25000), tx(3, '2026-11-14', 9900), tx(4, '2026-11-20', 400)];
    const found = findDuplicates(rows, existing);
    expect([...found.entries()].map(([i, t]) => [i, t.id])).toEqual([[0, 2], [1, 1]]);
  });

  it('counts a split receipt as its total', () => {
    const found = findDuplicates([line('2026-11-05', 30000)], [tx(7, '2026-11-05', 20000, 7), tx(8, '2026-11-05', 10000, 7)]);
    expect(found.get(0)?.amountCents).toBe(30000);
  });
});
