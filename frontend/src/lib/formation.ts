import { Position, SquadPlayer, Player, SQUAD_RULES } from "@/types";

export interface FormationCounts {
  gkp: number;
  def: number;
  mid: number;
  fwd: number;
}

/**
 * Counts starting players by position.
 */
export function countStartersByPosition(
  starters: Array<{ player?: Player; position?: Position }>
): FormationCounts {
  const counts: FormationCounts = { gkp: 0, def: 0, mid: 0, fwd: 0 };

  for (const s of starters) {
    const pos = s.player?.position || s.position;
    if (pos === Position.GKP) counts.gkp++;
    else if (pos === Position.DEF) counts.def++;
    else if (pos === Position.MID) counts.mid++;
    else if (pos === Position.FWD) counts.fwd++;
  }

  return counts;
}

/**
 * Detects the standard football formation string (e.g. "4-4-2", "3-5-2", "4-3-3").
 */
export function detectFormation(
  starters: Array<{ player?: Player; position?: Position }>
): string {
  const { def, mid, fwd } = countStartersByPosition(starters);
  if (def === 0 && mid === 0 && fwd === 0) return "4-4-2";
  return `${def}-${mid}-${fwd}`;
}

/**
 * Validates the starting XI formation rules.
 * FPL Rules: 1 GKP, 3-5 DEF, 2-5 MID, 1-3 FWD, exactly 11 players.
 */
export function validateFormation(
  starters: Array<{ player?: Player; position?: Position }>
): { valid: boolean; message?: string } {
  if (starters.length !== SQUAD_RULES.STARTERS) {
    return {
      valid: false,
      message: `Starting XI must contain exactly ${SQUAD_RULES.STARTERS} players (currently ${starters.length}).`,
    };
  }

  const { gkp, def, mid, fwd } = countStartersByPosition(starters);

  if (gkp !== 1) {
    return { valid: false, message: "Lineup must have exactly 1 starting Goalkeeper." };
  }
  if (def < SQUAD_RULES.MIN_STARTERS[Position.DEF] || def > 5) {
    return { valid: false, message: "Lineup must have between 3 and 5 starting Defenders." };
  }
  if (mid < SQUAD_RULES.MIN_STARTERS[Position.MID] || mid > 5) {
    return { valid: false, message: "Lineup must have between 2 and 5 starting Midfielders." };
  }
  if (fwd < SQUAD_RULES.MIN_STARTERS[Position.FWD] || fwd > 3) {
    return { valid: false, message: "Lineup must have between 1 and 3 starting Forwards." };
  }

  return { valid: true };
}

/**
 * Comprehensive squad validation according to FantasyXI & Premier League rules.
 */
export function validateCompleteSquad(players: Array<{
  player?: Player;
  isStarter: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
}>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (players.length !== SQUAD_RULES.TOTAL_PLAYERS) {
    errors.push(`Squad must contain exactly ${SQUAD_RULES.TOTAL_PLAYERS} players (currently ${players.length}).`);
  }

  // Count positions
  const posCounts: Record<Position, number> = {
    [Position.GKP]: 0,
    [Position.DEF]: 0,
    [Position.MID]: 0,
    [Position.FWD]: 0,
  };

  const clubCounts: Record<number, number> = {};
  let totalCost = 0;
  let captainCount = 0;
  let viceCaptainCount = 0;

  const starters: Array<{ player?: Player }> = [];

  for (const item of players) {
    if (item.player) {
      const p = item.player;
      posCounts[p.position] = (posCounts[p.position] || 0) + 1;
      clubCounts[p.teamId] = (clubCounts[p.teamId] || 0) + 1;
      totalCost += p.price;
    }

    if (item.isStarter) {
      starters.push(item);
      if (item.isCaptain) captainCount++;
      if (item.isViceCaptain) viceCaptainCount++;
    }
  }

  // Check position counts
  if (posCounts[Position.GKP] !== SQUAD_RULES.POSITION_COUNTS[Position.GKP]) {
    errors.push(`Must have exactly ${SQUAD_RULES.POSITION_COUNTS[Position.GKP]} Goalkeepers.`);
  }
  if (posCounts[Position.DEF] !== SQUAD_RULES.POSITION_COUNTS[Position.DEF]) {
    errors.push(`Must have exactly ${SQUAD_RULES.POSITION_COUNTS[Position.DEF]} Defenders.`);
  }
  if (posCounts[Position.MID] !== SQUAD_RULES.POSITION_COUNTS[Position.MID]) {
    errors.push(`Must have exactly ${SQUAD_RULES.POSITION_COUNTS[Position.MID]} Midfielders.`);
  }
  if (posCounts[Position.FWD] !== SQUAD_RULES.POSITION_COUNTS[Position.FWD]) {
    errors.push(`Must have exactly ${SQUAD_RULES.POSITION_COUNTS[Position.FWD]} Forwards.`);
  }

  // Check club limits
  for (const [teamId, count] of Object.entries(clubCounts)) {
    if (count > SQUAD_RULES.MAX_PER_TEAM) {
      errors.push(`Exceeded club limit: Maximum ${SQUAD_RULES.MAX_PER_TEAM} players allowed from team ID ${teamId}.`);
    }
  }

  // Check budget (prices stored in tenths, e.g. 1000 = 100.0m)
  if (totalCost > SQUAD_RULES.STARTING_BUDGET * 10) {
    errors.push(
      `Squad cost £${(totalCost / 10).toFixed(1)}m exceeds available budget of £${SQUAD_RULES.STARTING_BUDGET.toFixed(1)}m.`
    );
  }

  // Check starters
  const formationCheck = validateFormation(starters);
  if (!formationCheck.valid && formationCheck.message) {
    errors.push(formationCheck.message);
  }

  // Check captaincy
  if (captainCount !== 1) {
    errors.push("Squad must designate exactly 1 active Captain among starters.");
  }
  if (viceCaptainCount !== 1) {
    errors.push("Squad must designate exactly 1 active Vice-Captain among starters.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export interface SubstitutionValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates whether substituting player A with player B would produce a valid squad & formation.
 */
export function validateSubstitution(
  playerA: { playerId: number; isStarter: boolean; player: Player },
  playerB: { playerId: number; isStarter: boolean; player: Player },
  allPlayers: Array<{ playerId: number; isStarter: boolean; player: Player }>
): SubstitutionValidationResult {
  if (playerA.playerId === playerB.playerId) {
    return { valid: false, reason: "Cannot substitute a player with themselves." };
  }

  const aIsGkp = playerA.player.position === Position.GKP;
  const bIsGkp = playerB.player.position === Position.GKP;

  // Goalkeepers can only be swapped with other Goalkeepers
  if (aIsGkp !== bIsGkp) {
    return {
      valid: false,
      reason: "Goalkeepers can only be swapped with another Goalkeeper.",
    };
  }

  // Swapping two starters or two bench players is always valid for outfielders
  if (playerA.isStarter === playerB.isStarter) {
    return { valid: true };
  }

  // Tactical substitution: 1 Starter <-> 1 Bench
  const starter = playerA.isStarter ? playerA : playerB;
  const sub = playerA.isStarter ? playerB : playerA;

  // Same position swap doesn't alter formation
  if (starter.player.position === sub.player.position) {
    return { valid: true };
  }

  // Count current starters
  const currentStarters = allPlayers.filter((p) => p.isStarter);
  let def = currentStarters.filter((p) => p.player.position === Position.DEF).length;
  let mid = currentStarters.filter((p) => p.player.position === Position.MID).length;
  let fwd = currentStarters.filter((p) => p.player.position === Position.FWD).length;

  // Outgoing starter
  if (starter.player.position === Position.DEF) def--;
  else if (starter.player.position === Position.MID) mid--;
  else if (starter.player.position === Position.FWD) fwd--;

  // Incoming substitute
  if (sub.player.position === Position.DEF) def++;
  else if (sub.player.position === Position.MID) mid++;
  else if (sub.player.position === Position.FWD) fwd++;

  if (def < 3) {
    return {
      valid: false,
      reason: `Formation invalid: Minimum 3 Defenders required (would leave ${def}).`,
    };
  }
  if (def > 5) {
    return {
      valid: false,
      reason: `Formation invalid: Maximum 5 Defenders allowed (would have ${def}).`,
    };
  }
  if (mid < 2) {
    return {
      valid: false,
      reason: `Formation invalid: Minimum 2 Midfielders required (would leave ${mid}).`,
    };
  }
  if (mid > 5) {
    return {
      valid: false,
      reason: `Formation invalid: Maximum 5 Midfielders allowed (would have ${mid}).`,
    };
  }
  if (fwd < 1) {
    return {
      valid: false,
      reason: `Formation invalid: Minimum 1 Forward required (would leave ${fwd}).`,
    };
  }
  if (fwd > 3) {
    return {
      valid: false,
      reason: `Formation invalid: Maximum 3 Forwards allowed (would have ${fwd}).`,
    };
  }

  return { valid: true };
}
