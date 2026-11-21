/**
 * mergeResolver.ts — FantasyXI Issue #457
 *
 * Pure 3-way merge for the offline transfer journal.
 *
 *   base   = last synced server state (the journal base snapshot)
 *   local  = base + replayed journal entries (the offline draft)
 *   remote = current server state at reconnect time
 *
 * A change is a conflict only when both sides touched the same thing in
 * incompatible ways, or when the draft's assumptions broke upstream:
 *
 *   - price-changed:       a player the draft touched now costs something
 *     else on the server. Untouched players adopt the new price silently.
 *   - player-transferred-out: a player the draft kept or added is no
 *     longer available upstream.
 *   - both-changed:        the same player's role (starter / captain /
 *     vice-captain / order) or membership was changed on both sides.
 *   - deadline-locked:     the gameweek deadline passed while offline;
 *     nothing can be committed until the manager decides.
 *
 * Everything else merges automatically: local-only changes apply, and
 * remote-only changes (a price move on an untouched player, a server-side
 * addition) are adopted.
 *
 * Resolution semantics (per conflict, chosen in the modal):
 *   - "mine":   keep the draft's choice for that player. For a price
 *     change that means keeping the player at the new server price; for a
 *     transferred-out player it keeps the player in the draft and lets the
 *     commit attempt surface the server's rejection.
 *   - "server": take the server's version. For a both-changed player that
 *     is the remote role; for a price change on a player the draft added,
 *     it undoes that transfer-in (a player already in the base squad stays
 *     in it at the new price either way — a price is not negotiable). For
 *     a transferred-out player it drops them from the draft. For a locked
 *     deadline it discards the whole draft; "mine" there keeps the draft
 *     saved on the device instead of committing it.
 */

import { Position } from "@/types";
import type { JournalPlayer } from "./transferJournal";

/** One player in a merge input: the fields the merge reasons about. */
export interface MergePlayer {
  playerId: number;
  displayName: string;
  position: Position;
  teamId: number;
  /** Price in tenths, e.g. 65 = £6.5m. */
  price: number;
  isStarter: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
  positionOrder: number;
  isAvailable: boolean;
}

export function journalPlayersToMergePlayers(players: JournalPlayer[]): MergePlayer[] {
  return players.map((p) => ({
    playerId: p.playerId,
    displayName: p.player.displayName || p.player.lastName,
    position: p.player.position,
    teamId: p.player.teamId,
    price: p.player.price,
    isStarter: p.isStarter,
    isCaptain: p.isCaptain,
    isViceCaptain: p.isViceCaptain,
    positionOrder: p.positionOrder,
    isAvailable: p.player.isAvailable,
  }));
}

/** Converts server SquadPlayer rows (player may be a partial snapshot). */
export function squadPlayersToMergePlayers(
  players: Array<{
    playerId: number;
    player?: {
      displayName?: string;
      lastName?: string;
      position: Position;
      teamId: number;
      price: number;
      isAvailable: boolean;
    } | null;
    isStarter: boolean;
    isCaptain: boolean;
    isViceCaptain: boolean;
    positionOrder: number;
  }>
): MergePlayer[] {
  return players.map((p) => ({
    playerId: p.playerId,
    displayName: p.player?.displayName || p.player?.lastName || `Player ${p.playerId}`,
    position: p.player?.position ?? Position.MID,
    teamId: p.player?.teamId ?? 0,
    price: p.player?.price ?? 0,
    isStarter: p.isStarter,
    isCaptain: p.isCaptain,
    isViceCaptain: p.isViceCaptain,
    positionOrder: p.positionOrder,
    isAvailable: p.player?.isAvailable ?? true,
  }));
}

/** "£6.5m" from a price stored in tenths. */
export function formatPrice(tenths: number): string {
  return `£${(tenths / 10).toFixed(1)}m`;
}

export type MergeConflictKind =
  | "price-changed"
  | "player-transferred-out"
  | "deadline-locked"
  | "both-changed";

export interface MergeConflict {
  id: string;
  kind: MergeConflictKind;
  playerId?: number;
  playerName?: string;
  message: string;
  /** Human-readable side summaries shown in the modal. */
  baseLabel: string;
  localLabel: string;
  remoteLabel: string;
  basePrice?: number;
  localPrice?: number;
  remotePrice?: number;
}

export type MergeResolution = "mine" | "server";
export type MergeResolutionMap = Record<string, MergeResolution>;

/** Safe default per conflict: keep the draft, except where the server must win. */
export function defaultResolution(conflict: MergeConflict): MergeResolution {
  return conflict.kind === "player-transferred-out" || conflict.kind === "deadline-locked"
    ? "server"
    : "mine";
}

export function defaultResolutions(conflicts: MergeConflict[]): MergeResolutionMap {
  return Object.fromEntries(conflicts.map((c) => [c.id, defaultResolution(c)]));
}

export const CONFLICT_KIND_LABELS: Record<MergeConflictKind, string> = {
  "price-changed": "Price changed",
  "player-transferred-out": "Player transferred out",
  "deadline-locked": "Deadline locked",
  "both-changed": "Changed on both sides",
};

export interface ThreeWayMergeInput {
  base: MergePlayer[];
  local: MergePlayer[];
  remote: MergePlayer[];
  /** Players the journal touched; price changes only conflict for these. */
  touchedPlayerIds?: Set<number> | number[];
  /** Players unavailable upstream (transferred out / not in the player pool). */
  unavailablePlayerIds?: Set<number> | number[];
  deadlineLocked?: boolean;
  deadline?: string;
}

export interface ThreeWayMergeResult {
  merged: MergePlayer[];
  conflicts: MergeConflict[];
  /** Plain-language notes for the changes that merged without a decision. */
  autoMerged: string[];
}

type RoleField = "isStarter" | "isCaptain" | "isViceCaptain" | "positionOrder";

const ROLE_FIELDS: RoleField[] = ["isStarter", "isCaptain", "isViceCaptain", "positionOrder"];

function roleDiff(a: MergePlayer, b: MergePlayer): RoleField[] {
  return ROLE_FIELDS.filter((f) => a[f] !== b[f]);
}

function roleSummary(p: MergePlayer): string {
  const bits = [p.isStarter ? "Starter" : "Bench"];
  if (p.isCaptain) bits.push("Captain");
  if (p.isViceCaptain) bits.push("Vice-captain");
  return bits.join(" · ");
}

function byId(players: MergePlayer[]): Map<number, MergePlayer> {
  return new Map(players.map((p) => [p.playerId, p]));
}

function normalizeOrder(players: MergePlayer[]): MergePlayer[] {
  return [...players]
    .sort((a, b) => a.positionOrder - b.positionOrder || a.playerId - b.playerId)
    .map((p, idx) => ({ ...p, positionOrder: idx + 1 }));
}

export function threeWayMerge(input: ThreeWayMergeInput): ThreeWayMergeResult {
  const { base, local, remote } = input;
  const touched = new Set(input.touchedPlayerIds ?? []);
  const unavailable = new Set(input.unavailablePlayerIds ?? []);
  const baseMap = byId(base);
  const localMap = byId(local);
  const remoteMap = byId(remote);
  const merged: MergePlayer[] = [];
  const conflicts: MergeConflict[] = [];
  const autoMerged: string[] = [];

  if (input.deadlineLocked) {
    conflicts.push({
      id: "deadline-locked",
      kind: "deadline-locked",
      message: input.deadline
        ? `The gameweek deadline (${input.deadline}) passed while you were offline, so no transfer can be committed now.`
        : "The gameweek deadline passed while you were offline, so no transfer can be committed now.",
      baseLabel: "Draft made before the deadline",
      localLabel: `${local.length} players in your offline draft`,
      remoteLabel: "Server squad is locked for this gameweek",
    });
    // Nothing else is decided while the deadline blocks the sync; the
    // merged view is the server state the manager would fall back to.
    return { merged: normalizeOrder(remote), conflicts, autoMerged };
  }

  const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

  for (const id of ids) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    const name = l?.displayName ?? r?.displayName ?? b?.displayName ?? `Player ${id}`;
    const isUnavailable = unavailable.has(id) || r?.isAvailable === false;

    // Added locally.
    if (!b && l && !r) {
      if (isUnavailable) {
        conflicts.push({
          id: `transferred-out-${id}`,
          kind: "player-transferred-out",
          playerId: id,
          playerName: name,
          message: `${name} was transferred out upstream while you were offline, so the server no longer lists them as available.`,
          baseLabel: "Not in your squad",
          localLabel: `Transferred in · ${formatPrice(l.price)}`,
          remoteLabel: "Not available",
          localPrice: l.price,
        });
        merged.push(l);
      } else {
        merged.push(l);
        autoMerged.push(`Kept your transfer in: ${name}.`);
      }
      continue;
    }

    // Added remotely (another session / device).
    if (!b && !l && r) {
      merged.push(r);
      autoMerged.push(`Took the server addition: ${name}.`);
      continue;
    }

    // Removed on both sides.
    if (b && !l && !r) continue;

    // Added on both sides: the draft transferred the player in, and the
    // server lists them too (e.g. another session added them first).
    if (!b && l && r) {
      if (l.price !== r.price) {
        conflicts.push({
          id: `price-changed-${id}`,
          kind: "price-changed",
          playerId: id,
          playerName: name,
          message: `${name} changed price from ${formatPrice(l.price)} to ${formatPrice(r.price)} while you were offline. Your draft budget was calculated at the old price.`,
          baseLabel: "Not in your squad",
          localLabel: `Transferred in · ${formatPrice(l.price)}`,
          remoteLabel: `Transferred in · ${formatPrice(r.price)}`,
          localPrice: l.price,
          remotePrice: r.price,
        });
        merged.push({ ...l, price: r.price });
      } else if (roleDiff(l, r).length > 0) {
        conflicts.push({
          id: `both-changed-${id}`,
          kind: "both-changed",
          playerId: id,
          playerName: name,
          message: `${name} was added on both sides with different roles: your draft set ${roleSummary(l)}, the server has ${roleSummary(r)}.`,
          baseLabel: "Not in your squad",
          localLabel: roleSummary(l),
          remoteLabel: roleSummary(r),
          localPrice: l.price,
          remotePrice: r.price,
        });
        merged.push({ ...l, price: r.price });
      } else {
        merged.push(l);
        autoMerged.push(`Both sides added ${name}; kept one copy.`);
      }
      continue;
    }

    // Removed remotely, kept locally.
    if (b && l && !r) {
      if (roleDiff(b, l).length > 0) {
        conflicts.push({
          id: `both-changed-${id}`,
          kind: "both-changed",
          playerId: id,
          playerName: name,
          message: `${name} was removed on the server, but your draft changed their role (${roleSummary(b)} → ${roleSummary(l)}).`,
          baseLabel: roleSummary(b),
          localLabel: roleSummary(l),
          remoteLabel: "Removed from the squad",
          basePrice: b.price,
          localPrice: l.price,
        });
        merged.push(l);
      } else {
        autoMerged.push(`Took the server removal: ${name}.`);
      }
      continue;
    }

    // Removed locally, changed remotely.
    if (b && !l && r) {
      if (roleDiff(b, r).length > 0 || r.price !== b.price) {
        conflicts.push({
          id: `both-changed-${id}`,
          kind: "both-changed",
          playerId: id,
          playerName: name,
          message: `${name} was changed on the server (${roleSummary(b)} → ${roleSummary(r)}), but your draft removed them.`,
          baseLabel: roleSummary(b),
          localLabel: "Removed from the squad",
          remoteLabel: roleSummary(r),
          basePrice: b.price,
          remotePrice: r.price,
        });
        merged.push(r);
      } else {
        autoMerged.push(`Kept your transfer out: ${name}.`);
      }
      continue;
    }

    // Present on all three sides.
    if (b && l && r) {
      if (isUnavailable) {
        conflicts.push({
          id: `transferred-out-${id}`,
          kind: "player-transferred-out",
          playerId: id,
          playerName: name,
          message: `${name} was transferred out upstream while you were offline, so the server no longer lists them as available.`,
          baseLabel: `${roleSummary(b)} · ${formatPrice(b.price)}`,
          localLabel: `${roleSummary(l)} · ${formatPrice(l.price)}`,
          remoteLabel: "Not available",
          basePrice: b.price,
          localPrice: l.price,
        });
        merged.push(l);
        continue;
      }

      const localChanged = roleDiff(b, l);
      const remoteChanged = roleDiff(b, r);
      const overlapping = localChanged.filter((f) => remoteChanged.includes(f) && l[f] !== r[f]);
      const priceChanged = r.price !== b.price;

      if (overlapping.length > 0) {
        conflicts.push({
          id: `both-changed-${id}`,
          kind: "both-changed",
          playerId: id,
          playerName: name,
          message: `${name} was changed on both sides: your draft set ${roleSummary(l)}, the server has ${roleSummary(r)}.`,
          baseLabel: roleSummary(b),
          localLabel: roleSummary(l),
          remoteLabel: roleSummary(r),
          basePrice: b.price,
          localPrice: l.price,
          remotePrice: r.price,
        });
        // Merged view starts from the draft; the resolution picks the side.
        merged.push({ ...l, price: r.price });
        continue;
      }

      // No role clash: start from the server (adopts its price and any
      // remote-only role change), then overlay local-only role changes.
      const combined: MergePlayer = { ...r };
      for (const field of localChanged) {
        (combined as Record<RoleField, number | boolean>)[field] = l[field];
      }

      if (priceChanged && touched.has(id)) {
        conflicts.push({
          id: `price-changed-${id}`,
          kind: "price-changed",
          playerId: id,
          playerName: name,
          message: `${name} changed price from ${formatPrice(b.price)} to ${formatPrice(r.price)} while you were offline. Your draft budget was calculated at the old price.`,
          baseLabel: `${roleSummary(b)} · ${formatPrice(b.price)}`,
          localLabel: `${roleSummary(l)} · ${formatPrice(b.price)} (draft price)`,
          remoteLabel: `${roleSummary(r)} · ${formatPrice(r.price)}`,
          basePrice: b.price,
          localPrice: l.price,
          remotePrice: r.price,
        });
      } else if (priceChanged) {
        autoMerged.push(`${name} is now ${formatPrice(r.price)} (was ${formatPrice(b.price)}); new price adopted.`);
      }
      if (localChanged.length > 0 && remoteChanged.length === 0) {
        autoMerged.push(`Kept your change: ${name} (${roleSummary(b)} → ${roleSummary(l)}).`);
      } else if (remoteChanged.length > 0 && localChanged.length === 0) {
        autoMerged.push(`Took the server change: ${name} (${roleSummary(b)} → ${roleSummary(r)}).`);
      }
      merged.push(combined);
    }
  }

  return { merged: normalizeOrder(merged), conflicts, autoMerged };
}

export interface ApplyResolutionsInput {
  base: MergePlayer[];
  local: MergePlayer[];
  remote: MergePlayer[];
  merged: MergePlayer[];
  conflicts: MergeConflict[];
  resolutions: MergeResolutionMap;
}

/**
 * Applies the manager's per-conflict choices to the merged squad.
 * Deadline-locked conflicts are not applied here — the sync layer decides
 * whether to hold or discard the whole draft.
 */
export function applyMergeResolutions(input: ApplyResolutionsInput): MergePlayer[] {
  const { base, local, remote, conflicts, resolutions } = input;
  const baseMap = byId(base);
  const localMap = byId(local);
  const remoteMap = byId(remote);
  const result = new Map<number, MergePlayer>(input.merged.map((p) => [p.playerId, { ...p }]));

  for (const conflict of conflicts) {
    const choice = resolutions[conflict.id] ?? defaultResolution(conflict);
    const id = conflict.playerId;
    if (id === undefined) continue; // deadline-locked: handled by the sync layer

    if (conflict.kind === "player-transferred-out") {
      if (choice === "server") {
        result.delete(id);
      } else {
        const keep = localMap.get(id);
        if (keep) result.set(id, { ...keep });
      }
      continue;
    }

    if (conflict.kind === "price-changed") {
      if (choice === "server" && !baseMap.get(id)) {
        // The player was transferred in by the draft: "take server" undoes
        // that transfer. A player already in the base squad stays in it at
        // the new server price either way — the price itself is not
        // negotiable, so the resolution there only acknowledges the change.
        result.delete(id);
      } else {
        const keep = localMap.get(id);
        const remotePlayer = remoteMap.get(id);
        if (keep) result.set(id, { ...keep, price: remotePlayer?.price ?? keep.price });
      }
      continue;
    }

    if (conflict.kind === "both-changed") {
      if (choice === "server") {
        // "Take server" means the remote role, at the remote price.
        const remotePlayer = remoteMap.get(id);
        if (remotePlayer) result.set(id, { ...remotePlayer });
        else result.delete(id);
      } else {
        const keep = localMap.get(id);
        const remotePlayer = remoteMap.get(id);
        if (keep) result.set(id, { ...keep, price: remotePlayer?.price ?? keep.price });
        else result.delete(id);
      }
    }
  }

  return normalizeOrder([...result.values()]);
}
