import type { Account } from '../shared/types';

/**
 * Archived = a settled account the user put away: hidden from the account
 * lists and from pickers for new entries, its history untouched. One that
 * somehow carries a balance again (an edited old entry, say) counts as
 * active, so no money or debt is ever hidden. New activity on an archived
 * account restores it server-side.
 */
export function isArchived(a: Account): boolean {
  return a.archivedAt !== null && a.balanceCents === 0;
}

/** 'Oct 29, 2026' from archivedAt ('YYYY-MM-DD HH:MM:SS', server time). */
export function archivedOnLabel(a: Account): string {
  if (a.archivedAt === null) return '';
  const [y, m, d] = a.archivedAt.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
