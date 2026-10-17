export interface SwissMatchResult {
  round: number;
  homePlayerId: string;
  /** null indicates a BYE round for homePlayerId */
  awayPlayerId: string | null;
  homeFantasyPoints: number;
  awayFantasyPoints: number;
}

export interface SwissPairing {
  round: number;
  tableNumber: number;
  homePlayerId: string;
  awayPlayerId: string | null;
  isBye: boolean;
}

export interface SwissStandingEntry {
  rank: number;
  playerId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  byes: number;
  matchPoints: number;
  buchholzScore: number;
  sonnenbornBergerScore: number;
  fantasyPointsFor: number;
  fantasyPointsAgainst: number;
  fantasyPointsDifferential: number;
  opponentsPlayed: string[];
}

interface InternalPlayerRecord {
  playerId: string;
  wins: number;
  draws: number;
  losses: number;
  byes: number;
  matchPoints: number;
  fantasyPointsFor: number;
  fantasyPointsAgainst: number;
  opponents: string[];
  defeatedOpponents: string[];
  drawnOpponents: string[];
}

export class SwissTournamentPairingService {
  /**
   * Computes full Swiss tournament standings with multi-level tie-breakers:
   * 1. Match Points (Win = 3, Draw = 1, Loss = 0, Bye = 3)
   * 2. Buchholz Score (sum of all faced opponents' current match points)
   * 3. Sonnenborn-Berger Score (sum of defeated opponents' match points + 0.5 * drawn opponents' match points)
   * 4. Cumulative Fantasy Points Differential (fantasyPointsFor - fantasyPointsAgainst)
   * 5. Total Fantasy Points For
   * 6. Deterministic lexical playerId tie-break
   */
  public static calculateStandings(
    playerIds: string[],
    completedMatches: SwissMatchResult[]
  ): SwissStandingEntry[] {
    const records = new Map<string, InternalPlayerRecord>();
    for (const id of playerIds) {
      records.set(id, {
        playerId: id,
        wins: 0,
        draws: 0,
        losses: 0,
        byes: 0,
        matchPoints: 0,
        fantasyPointsFor: 0,
        fantasyPointsAgainst: 0,
        opponents: [],
        defeatedOpponents: [],
        drawnOpponents: [],
      });
    }

    for (const match of completedMatches) {
      const home = records.get(match.homePlayerId);
      if (!home) continue;

      if (match.awayPlayerId === null) {
        // BYE round awards 3 match points and records the player's fantasy points
        home.byes += 1;
        home.matchPoints += 3;
        home.fantasyPointsFor += match.homeFantasyPoints;
        continue;
      }

      const away = records.get(match.awayPlayerId);
      if (!away) continue;

      home.opponents.push(away.playerId);
      away.opponents.push(home.playerId);

      home.fantasyPointsFor += match.homeFantasyPoints;
      home.fantasyPointsAgainst += match.awayFantasyPoints;
      away.fantasyPointsFor += match.awayFantasyPoints;
      away.fantasyPointsAgainst += match.homeFantasyPoints;

      if (match.homeFantasyPoints > match.awayFantasyPoints) {
        home.wins += 1;
        home.matchPoints += 3;
        home.defeatedOpponents.push(away.playerId);
        away.losses += 1;
      } else if (match.homeFantasyPoints < match.awayFantasyPoints) {
        away.wins += 1;
        away.matchPoints += 3;
        away.defeatedOpponents.push(home.playerId);
        home.losses += 1;
      } else {
        home.draws += 1;
        away.draws += 1;
        home.matchPoints += 1;
        away.matchPoints += 1;
        home.drawnOpponents.push(away.playerId);
        away.drawnOpponents.push(home.playerId);
      }
    }

    const entries: SwissStandingEntry[] = [];
    for (const rec of records.values()) {
      let buchholz = 0;
      for (const oppId of rec.opponents) {
        buchholz += records.get(oppId)?.matchPoints ?? 0;
      }

      let sbScore = 0;
      for (const defId of rec.defeatedOpponents) {
        sbScore += records.get(defId)?.matchPoints ?? 0;
      }
      for (const drwId of rec.drawnOpponents) {
        sbScore += 0.5 * (records.get(drwId)?.matchPoints ?? 0);
      }

      const diff = rec.fantasyPointsFor - rec.fantasyPointsAgainst;

      entries.push({
        rank: 0,
        playerId: rec.playerId,
        played: rec.wins + rec.draws + rec.losses,
        wins: rec.wins,
        draws: rec.draws,
        losses: rec.losses,
        byes: rec.byes,
        matchPoints: rec.matchPoints,
        buchholzScore: buchholz,
        sonnenbornBergerScore: sbScore,
        fantasyPointsFor: rec.fantasyPointsFor,
        fantasyPointsAgainst: rec.fantasyPointsAgainst,
        fantasyPointsDifferential: diff,
        opponentsPlayed: [...rec.opponents],
      });
    }

    entries.sort((a, b) => {
      if (b.matchPoints !== a.matchPoints) return b.matchPoints - a.matchPoints;
      if (b.buchholzScore !== a.buchholzScore) return b.buchholzScore - a.buchholzScore;
      if (b.sonnenbornBergerScore !== a.sonnenbornBergerScore) {
        return b.sonnenbornBergerScore - a.sonnenbornBergerScore;
      }
      if (b.fantasyPointsDifferential !== a.fantasyPointsDifferential) {
        return b.fantasyPointsDifferential - a.fantasyPointsDifferential;
      }
      if (b.fantasyPointsFor !== a.fantasyPointsFor) {
        return b.fantasyPointsFor - a.fantasyPointsFor;
      }
      return a.playerId.localeCompare(b.playerId);
    });

    entries.forEach((e, idx) => {
      e.rank = idx + 1;
    });

    return entries;
  }

  /**
   * Generates the next Swiss round pairings from current standings and past matches.
   * - Guarantees no repeat matchups across the Swiss stage.
   * - Assigns a BYE to the lowest-ranked player who has not previously received a BYE when player count is odd.
   */
  public static generateNextRoundPairings(
    playerIds: string[],
    completedMatches: SwissMatchResult[],
    roundNumber: number
  ): SwissPairing[] {
    if (playerIds.length < 2) {
      throw new Error("At least 2 players are required for a Swiss tournament");
    }

    const standings = SwissTournamentPairingService.calculateStandings(
      playerIds,
      completedMatches
    );

    const playedSets = new Map<string, Set<string>>();
    for (const s of standings) {
      playedSets.set(s.playerId, new Set(s.opponentsPlayed));
    }

    let activePool = [...standings];
    let byeRecipient: SwissStandingEntry | null = null;

    // Handle odd number of players: lowest-ranked player with 0 byes gets the bye
    if (activePool.length % 2 === 1) {
      for (let i = activePool.length - 1; i >= 0; i--) {
        if (activePool[i].byes === 0) {
          byeRecipient = activePool[i];
          activePool.splice(i, 1);
          break;
        }
      }
      // Fallback if every player has somehow already had a bye
      if (!byeRecipient) {
        byeRecipient = activePool.pop()!;
      }
    }

    const orderedIds = activePool.map((s) => s.playerId);
    const pairs = SwissTournamentPairingService.findNonRepeatingPairings(
      orderedIds,
      playedSets
    );

    if (!pairs) {
      throw new Error(
        `Unable to construct non-repeating Swiss pairings for round ${roundNumber}`
      );
    }

    const result: SwissPairing[] = pairs.map(([homeId, awayId], index) => ({
      round: roundNumber,
      tableNumber: index + 1,
      homePlayerId: homeId,
      awayPlayerId: awayId,
      isBye: false,
    }));

    if (byeRecipient) {
      result.push({
        round: roundNumber,
        tableNumber: result.length + 1,
        homePlayerId: byeRecipient.playerId,
        awayPlayerId: null,
        isBye: true,
      });
    }

    return result;
  }

  /**
   * Backtracking solver that pairs top-ranked available players against the closest-ranked
   * valid opponent they have not yet faced.
   */
  private static findNonRepeatingPairings(
    remainingIds: string[],
    playedSets: Map<string, Set<string>>
  ): Array<[string, string]> | null {
    if (remainingIds.length === 0) {
      return [];
    }

    const firstId = remainingIds[0];
    const firstPlayed = playedSets.get(firstId) ?? new Set<string>();

    for (let i = 1; i < remainingIds.length; i++) {
      const candidateId = remainingIds[i];
      if (firstPlayed.has(candidateId)) {
        continue;
      }

      const nextRemaining = remainingIds
        .slice(1, i)
        .concat(remainingIds.slice(i + 1));

      const subResult = SwissTournamentPairingService.findNonRepeatingPairings(
        nextRemaining,
        playedSets
      );

      if (subResult !== null) {
        return [[firstId, candidateId], ...subResult];
      }
    }

    return null;
  }
}
