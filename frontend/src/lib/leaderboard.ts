/**
 * Pure helpers for the global leaderboard UI (query strings, pagination, copy).
 */

export interface LeaderboardParams {
  page: number;
  pageSize: number;
  search?: string;
  gameweekId?: number | null;
}

export function buildLeaderboardQuery({ page, pageSize, search, gameweekId }: LeaderboardParams): string {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const term = search?.trim();
  if (term) params.set("q", term);
  if (gameweekId) params.set("gameweekId", String(gameweekId));
  return `?${params.toString()}`;
}

export type PageItem = number | "ellipsis-start" | "ellipsis-end";

/**
 * Page numbers to show in the pagination bar: always the first and last page,
 * the current page and its neighbours, with ellipses for the gaps.
 */
export function visiblePages(current: number, total: number, siblings = 1): PageItem[] {
  if (total <= 0) return [];
  const pages = new Set<number>([1, total]);
  for (let p = current - siblings; p <= current + siblings; p++) {
    if (p >= 1 && p <= total) pages.add(p);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const items: PageItem[] = [];
  sorted.forEach((page, i) => {
    const previous = sorted[i - 1];
    if (previous !== undefined && page - previous === 2) {
      items.push(previous + 1); // a gap of one page is cheaper to show than an ellipsis
    } else if (previous !== undefined && page - previous > 2) {
      items.push(page < current ? "ellipsis-start" : "ellipsis-end");
    }
    items.push(page);
  });
  return items;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-GB");
}

/** "Showing 26–50 of 1,204 managers" */
export function resultRangeText(page: number, pageSize: number, total: number): string {
  if (total === 0) return "No managers to show";
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  if (first > total) return `No managers on this page (${formatCount(total)} in total)`;
  return `Showing ${formatCount(first)}–${formatCount(last)} of ${formatCount(total)} manager${total === 1 ? "" : "s"}`;
}

/** 1 -> "1st", 22 -> "22nd", 113 -> "113th" */
export function ordinal(value: number): string {
  const mod100 = value % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[value % 10] ?? "th";
  return `${formatCount(value)}${suffix}`;
}
