import { ChevronLeftIcon, ChevronRightIcon } from './Icons';
import { PAGE_SIZE_OPTIONS } from '../usePagedTable';

// Table footer: page-size ("View") selector, the visible range, and prev/next
// controls. Driven entirely by usePagedTable state passed down from the page.
export function Pager({
  page,
  pageCount,
  pageSize,
  setPage,
  setPageSize,
  rangeStart,
  rangeEnd,
  total,
  unit = 'rows',
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  setPage: (p: number) => void;
  setPageSize: (n: number) => void;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  unit?: string;
}) {
  return (
    <div className="pager">
      <label className="pager-size">
        <span>View</span>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          aria-label="Rows per page"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span className="pager-range">
        {total === 0 ? `No ${unit}` : `${rangeStart}–${rangeEnd} of ${total} ${unit}`}
      </span>
      <div className="pager-nav">
        <button
          className="btn-icon"
          onClick={() => setPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          title="Previous page"
        >
          <ChevronLeftIcon />
        </button>
        <span className="pager-page">
          {page} / {pageCount}
        </span>
        <button
          className="btn-icon"
          onClick={() => setPage(page + 1)}
          disabled={page >= pageCount}
          aria-label="Next page"
          title="Next page"
        >
          <ChevronRightIcon />
        </button>
      </div>
    </div>
  );
}
