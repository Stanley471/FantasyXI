import type { PerformanceAnalytics } from "@/types";

const CSV_HEADERS = [
  "squad_name",
  "gameweek",
  "points",
  "rank",
  "bench_points",
  "captain_points",
  "transfers",
  "chip_used",
];

function csvCell(value: string | number | null): string {
  const escaped = String(value ?? "").replace(/"/g, '""');
  return `"${escaped}"`;
}

/** Builds a spreadsheet-safe CSV export from the selected squad's history. */
export function buildPerformanceCsv(analytics: PerformanceAnalytics): string {
  const squadName = analytics.squads.find((squad) => squad.id === analytics.squadId)?.name ?? "";
  const rows = analytics.history.map((week) => [
    squadName,
    week.gameweekName,
    week.points,
    week.rank,
    week.benchPoints,
    week.captainPoints,
    week.transferCount,
    week.chip ?? "",
  ]);
  return [CSV_HEADERS, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** Serializes the complete analytics response using the API's data shape. */
export function buildPerformanceJson(analytics: PerformanceAnalytics): string {
  return JSON.stringify(analytics, null, 2);
}
