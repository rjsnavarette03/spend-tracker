import { useEffect, useMemo, useState } from 'react';

// A sort choice for a table: a stable `value` (used by the <select>), a human
// `label`, and the comparator it applies. Define these at module scope so their
// identity is stable across renders (keeps the memo below from rerunning).
export interface SortOption<T> {
  value: string;
  label: string;
  compare: (a: T, b: T) => number;
}

// Page-size choices offered by the Pager; the table defaults to the first (10).
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export interface PagedTable<T> {
  query: string;
  setQuery: (q: string) => void;
  sort: string;
  setSort: (s: string) => void;
  pageSize: number;
  setPageSize: (n: number) => void;
  page: number;
  setPage: (p: number) => void;
  pageCount: number;
  visible: T[]; // rows on the current page
  matched: T[]; // all rows after search + sort (for totals / export)
  totalCount: number; // rows.length (unfiltered)
  matchedCount: number; // matched.length (after search)
  rangeStart: number; // 1-based index of the first visible row (0 when empty)
  rangeEnd: number; // 1-based index of the last visible row
}

/**
 * Client-side search + sort + pagination over an in-memory row list.
 *
 * Search is instant (substring match, case-insensitive) over the string that
 * `searchOf` derives from a row. Sorting uses the chosen `SortOption`. The
 * result is paginated to `pageSize` (default 10). Pass `searchOf`/`sortOptions`
 * as stable references (module-scope) so the memo only recomputes on real
 * changes.
 */
export function usePagedTable<T>(
  rows: T[],
  searchOf: (row: T) => string,
  sortOptions: SortOption<T>[],
  opts?: { initialSort?: string; initialPageSize?: number }
): PagedTable<T> {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(opts?.initialSort ?? sortOptions[0]?.value ?? '');
  const [pageSize, setPageSize] = useState<number>(opts?.initialPageSize ?? PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(1);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = q
      ? rows.filter((r) => searchOf(r).toLowerCase().includes(q))
      : rows.slice();
    const opt = sortOptions.find((o) => o.value === sort);
    if (opt) out.sort(opt.compare);
    return out;
  }, [rows, query, sort, sortOptions, searchOf]);

  const pageCount = Math.max(1, Math.ceil(matched.length / pageSize));

  // Jump back to the first page when the filter/sort/size changes.
  useEffect(() => {
    setPage(1);
  }, [query, sort, pageSize]);
  // Never leave the page index past the end (e.g. after deletes or a reload
  // that returns fewer rows).
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const start = (page - 1) * pageSize;
  const visible = matched.slice(start, start + pageSize);

  return {
    query,
    setQuery,
    sort,
    setSort,
    pageSize,
    setPageSize,
    page,
    setPage,
    pageCount,
    visible,
    matched,
    totalCount: rows.length,
    matchedCount: matched.length,
    rangeStart: matched.length === 0 ? 0 : start + 1,
    rangeEnd: Math.min(start + pageSize, matched.length),
  };
}
