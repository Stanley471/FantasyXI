/**
 * Maps a player's raw FPL availability fields (status, chance of playing,
 * news) to a badge the UI can render (issue #494).
 */

export type AvailabilityBadgeColor = "red" | "orange" | "yellow";

export interface PlayerAvailabilityBadge {
  color: AvailabilityBadgeColor;
  label: string;
  tooltip: string;
}

export interface PlayerAvailabilityInput {
  status?: string | null;
  chanceOfPlayingNextRound?: number | null;
  news?: string | null;
  isAvailable: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  i: "Injured",
  s: "Suspended",
  d: "Doubtful",
  u: "Unavailable",
  n: "Not available",
};

/** Returns null when the player has no fitness doubt worth flagging. */
export function getPlayerAvailabilityBadge(
  player: PlayerAvailabilityInput
): PlayerAvailabilityBadge | null {
  const status = player.status ?? "a";
  const chance = player.chanceOfPlayingNextRound ?? null;

  const isFullyAvailable =
    status === "a" && player.isAvailable && (chance === null || chance === 100);
  if (isFullyAvailable) {
    return null;
  }

  let color: AvailabilityBadgeColor;
  if (chance === 0 || status === "s" || status === "u" || status === "n") {
    color = "red";
  } else if (chance === 25) {
    color = "orange";
  } else if (chance === 50 || chance === 75) {
    color = "yellow";
  } else if (status === "i" || status === "d" || !player.isAvailable) {
    // Injured/doubtful with no published percentage yet: treat as a hard doubt.
    color = "red";
  } else {
    return null;
  }

  const label = chance !== null ? `${chance}%` : STATUS_LABELS[status] ?? "Doubtful";
  const tooltip =
    player.news && player.news.trim().length > 0
      ? player.news.trim()
      : STATUS_LABELS[status] ?? "Chance of playing is uncertain";

  return { color, label, tooltip };
}
