import type { LeagueStandingsEntry } from "@/types";

const CSV_HEADERS = ["rank", "manager_name", "squad_name", "gameweek_points", "total_points"];

function csvCell(value: string | number | null): string {
  const escaped = String(value ?? "").replace(/"/g, '""');
  return `"${escaped}"`;
}

export interface StandingsExportRow {
  rank: number;
  managerName: string;
  squadName: string;
  gameweekPoints: number;
  totalPoints: number;
}

/**
 * Maps standings entries (already filtered/sorted for display) to export
 * rows. Prefers live gameweek points when available, falling back to the
 * entry's best recorded gameweek score.
 */
export function toStandingsExportRows(
  standings: LeagueStandingsEntry[],
  livePoints?: Record<string, number>
): StandingsExportRow[] {
  return standings.map((entry) => ({
    rank: entry.rank,
    managerName: entry.username,
    squadName: entry.squadName,
    gameweekPoints: livePoints?.[entry.userId] ?? entry.bestGameweekPoints ?? 0,
    totalPoints: entry.totalPoints,
  }));
}

/** Builds a spreadsheet-safe CSV export of league standings (issue #498). */
export function buildStandingsCsv(rows: StandingsExportRow[]): string {
  const dataRows = rows.map((r) => [r.rank, r.managerName, r.squadName, r.gameweekPoints, r.totalPoints]);
  return [CSV_HEADERS, ...dataRows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** Serializes league standings rows as formatted JSON. */
export function buildStandingsJson(rows: StandingsExportRow[]): string {
  return JSON.stringify(rows, null, 2);
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "league"
  );
}

/**
 * Builds a download filename carrying the league name and current gameweek,
 * plus a UTC timestamp so repeated exports never collide.
 */
export function buildStandingsExportFilename(
  leagueName: string,
  gameweekLabel: string | number | null | undefined,
  extension: "csv" | "json",
  now: Date = new Date()
): string {
  const leagueSlug = slugify(leagueName);
  const gwSlug = gameweekLabel !== null && gameweekLabel !== undefined ? slugify(String(gameweekLabel)) : "";
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${leagueSlug}-standings${gwSlug ? `-${gwSlug}` : ""}-${timestamp}.${extension}`;
}
