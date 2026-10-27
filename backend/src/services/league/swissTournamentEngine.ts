/**
 * Swiss-System Tournament Bracket Generator & Matchmaking Engine
 *
 * Implements:
 * 1. Monrad / Dutch Swiss-system matchmaking pairing by score groups.
 * 2. Strict repeat-matchup prevention across multi-round tournaments.
 * 3. Standings computation with Buchholz and Sonneborn-Berger tie-breakers.
 * 4. Deterministic bye allocation for odd participant counts (no duplicate byes).
 * 5. Gameweek progression state machine managing tournament round lifecycles.
 */

export interface SwissParticipant {
  id: string;
  name: string;
  seed: number;
  matchPoints: number; // 3 for win, 1 for draw, 0 for loss, 3 for bye
  wins: number;
  draws: number;
  losses: number;
  byes: number;
  pointsFor: number; // Cumulative fantasy points scored
  pointsAgainst: number;
  opponentsFaced: string[];
  matchHistory: Array<{
    round: number;
    opponentId: string | null;
    result: "WIN" | "DRAW" | "LOSS" | "BYE";
    score: number;
    opponentScore: number;
  }>;
  buchholzScore: number;
  sonnebornBergerScore: number;
  rank: number;
}

export interface SwissMatchup {
  id: string;
  round: number;
  homeParticipantId: string;
  awayParticipantId: string | null; // null represents a BYE
  homeScore?: number;
  awayScore?: number;
  isFinished: boolean;
  winnerId?: string | null; // null for draw or unfinished
}

export type SwissTournamentStatus =
  | "CREATED"
  | "ROUND_ACTIVE"
  | "ROUND_COMPLETED"
  | "TOURNAMENT_COMPLETED";

export interface SwissRound {
  roundNumber: number;
  gameweekId: number;
  isFinished: boolean;
  matchups: SwissMatchup[];
}

export interface SwissTournamentState {
  id: string;
  leagueId: string;
  totalRounds: number;
  currentRound: number;
  status: SwissTournamentStatus;
  participants: Record<string, SwissParticipant>;
  rounds: SwissRound[];
  createdAt: Date;
  updatedAt: Date;
}

export class SwissTournamentEngine {
  private state: SwissTournamentState;

  constructor(options: {
    id?: string;
    leagueId: string;
    participants: Array<{ id: string; name?: string; seed?: number }>;
    totalRounds?: number;
  }) {
    const totalCount = options.participants.length;
    if (totalCount < 2) {
      throw new Error("A tournament requires at least 2 participants.");
    }
    const participantIds = new Set(options.participants.map((participant) => participant.id));
    if (participantIds.size !== totalCount || options.participants.some((participant) => !participant.id.trim())) {
      throw new Error("Tournament participants must have unique, non-empty IDs.");
    }
    // Default rounds: log2(N) rounded up, minimum 3
    const calculatedRounds =
      totalCount > 1
        ? Math.max(3, Math.ceil(Math.log2(totalCount)))
        : 1;

    const totalRounds = options.totalRounds ?? calculatedRounds;
    if (!Number.isInteger(totalRounds) || totalRounds < 1) {
      throw new Error("Tournament rounds must be a positive integer.");
    }

    const participantsMap: Record<string, SwissParticipant> = {};
    options.participants.forEach((p, idx) => {
      participantsMap[p.id] = {
        id: p.id,
        name: p.name || `Player ${idx + 1}`,
        seed: p.seed ?? idx + 1,
        matchPoints: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        byes: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        opponentsFaced: [],
        matchHistory: [],
        buchholzScore: 0,
        sonnebornBergerScore: 0,
        rank: idx + 1,
      };
    });

    this.state = {
      id: options.id || `swiss-${options.leagueId}-${Date.now()}`,
      leagueId: options.leagueId,
      totalRounds,
      currentRound: 0,
      status: "CREATED",
      participants: participantsMap,
      rounds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  public getState(): SwissTournamentState {
    return this.state;
  }

  public getParticipants(): SwissParticipant[] {
    return Object.values(this.state.participants);
  }

  public getStandings(): SwissParticipant[] {
    this.recomputeStandingsAndTieBreakers();
    return Object.values(this.state.participants).sort((a, b) => a.rank - b.rank);
  }

  public getCurrentRound(): SwissRound | null {
    if (this.state.currentRound <= 0 || this.state.rounds.length === 0) {
      return null;
    }
    return this.state.rounds[this.state.currentRound - 1] || null;
  }

  /**
   * Recalculates Buchholz and Sonneborn-Berger metrics and ranks participants.
   */
  public recomputeStandingsAndTieBreakers(): void {
    const participants = Object.values(this.state.participants);
    const participantMap = this.state.participants;

    // 1. Compute Buchholz & Sonneborn-Berger scores
    for (const p of participants) {
      let buchholz = 0;
      let sonnebornBerger = 0;

      for (const oppId of p.opponentsFaced) {
        const opp = participantMap[oppId];
        if (!opp) continue;

        buchholz += opp.matchPoints;

        // Check head-to-head outcome against this opponent
        const match = p.matchHistory.find((m) => m.opponentId === oppId);
        if (match) {
          if (match.result === "WIN") {
            sonnebornBerger += opp.matchPoints;
          } else if (match.result === "DRAW") {
            sonnebornBerger += opp.matchPoints * 0.5;
          }
        }
      }

      p.buchholzScore = buchholz;
      p.sonnebornBergerScore = sonnebornBerger;
    }

    // 2. Sort participants according to Swiss tie-break hierarchy
    participants.sort((a, b) => {
      // 1. Tournament Match Points (descending)
      if (b.matchPoints !== a.matchPoints) {
        return b.matchPoints - a.matchPoints;
      }
      // 2. Buchholz Score (strength of schedule) (descending)
      if (b.buchholzScore !== a.buchholzScore) {
        return b.buchholzScore - a.buchholzScore;
      }
      // 3. Sonneborn-Berger Score (descending)
      if (b.sonnebornBergerScore !== a.sonnebornBergerScore) {
        return b.sonnebornBergerScore - a.sonnebornBergerScore;
      }
      // 4. Net Fantasy Points Difference (descending)
      const diffA = a.pointsFor - a.pointsAgainst;
      const diffB = b.pointsFor - b.pointsAgainst;
      if (diffB !== diffA) {
        return diffB - diffA;
      }
      // 5. Total Fantasy Points Scored (descending)
      if (b.pointsFor !== a.pointsFor) {
        return b.pointsFor - a.pointsFor;
      }
      // 6. Seed / ID tie-break (ascending)
      return a.seed - b.seed || a.id.localeCompare(b.id);
    });

    // 3. Assign ranks
    participants.forEach((p, idx) => {
      p.rank = idx + 1;
    });
  }

  /**
   * Starts tournament or advances to the next round, generating pairings.
   */
  public generateNextRound(gameweekId: number): SwissRound {
    if (this.state.status === "TOURNAMENT_COMPLETED") {
      throw new Error("Tournament is already completed.");
    }
    if (
      this.state.status === "ROUND_ACTIVE" &&
      this.getCurrentRound() &&
      !this.getCurrentRound()!.isFinished
    ) {
      throw new Error("Current round has unfinished matches.");
    }

    const nextRoundNumber = this.state.currentRound + 1;
    if (nextRoundNumber > this.state.totalRounds) {
      this.state.status = "TOURNAMENT_COMPLETED";
      throw new Error("Maximum tournament rounds reached.");
    }

    this.recomputeStandingsAndTieBreakers();

    const matchups = this.computePairings(nextRoundNumber);

    const round: SwissRound = {
      roundNumber: nextRoundNumber,
      gameweekId,
      isFinished: false,
      matchups,
    };

    this.state.rounds.push(round);
    this.state.currentRound = nextRoundNumber;
    this.state.status = "ROUND_ACTIVE";
    this.state.updatedAt = new Date();

    return round;
  }

  /**
   * Computes Swiss pairings adhering to score groups and preventing repeat matchups.
   */
  private computePairings(roundNumber: number): SwissMatchup[] {
    const participants = this.getStandings();
    const isOdd = participants.length % 2 !== 0;

    let availablePlayers = [...participants];
    const matchups: SwissMatchup[] = [];

    // Handle odd number of players: Assign exactly 1 BYE
    if (isOdd) {
      // Find lowest-ranked player who has not received a bye yet
      let byePlayerIndex = -1;
      for (let i = availablePlayers.length - 1; i >= 0; i--) {
        if (availablePlayers[i].byes === 0) {
          byePlayerIndex = i;
          break;
        }
      }
      // If all players have received a bye (unlikely unless rounds > N), pick lowest rank
      if (byePlayerIndex === -1) {
        byePlayerIndex = availablePlayers.length - 1;
      }

      const byePlayer = availablePlayers.splice(byePlayerIndex, 1)[0];
      matchups.push({
        id: `match-${this.state.id}-r${roundNumber}-bye`,
        round: roundNumber,
        homeParticipantId: byePlayer.id,
        awayParticipantId: null, // BYE
        homeScore: 0,
        awayScore: 0,
        isFinished: true, // Byes are immediately marked completed
        winnerId: byePlayer.id,
      });

      // Update bye player match points & stats immediately
      byePlayer.byes += 1;
      byePlayer.matchPoints += 3; // Standard 3 points for bye win
      byePlayer.wins += 1;
      byePlayer.matchHistory.push({
        round: roundNumber,
        opponentId: null,
        result: "BYE",
        score: 0,
        opponentScore: 0,
      });
    }

    // Round 1 Pairing: Top-half vs Bottom-half seeding
    if (roundNumber === 1) {
      const half = availablePlayers.length / 2;
      for (let i = 0; i < half; i++) {
        const home = availablePlayers[i];
        const away = availablePlayers[i + half];
        matchups.push({
          id: `match-${this.state.id}-r${roundNumber}-${i + 1}`,
          round: roundNumber,
          homeParticipantId: home.id,
          awayParticipantId: away.id,
          isFinished: false,
        });
      }
      return matchups;
    }

    // Rounds 2+: Score-bracket pairing with backtracking
    const pairedMatches = this.pairByScoreBrackets(availablePlayers, roundNumber);
    matchups.push(...pairedMatches);

    return matchups;
  }

  /**
   * Pairs available players by grouping them into score brackets and avoiding repeat matchups.
   */
  private pairByScoreBrackets(
    players: SwissParticipant[],
    roundNumber: number
  ): SwissMatchup[] {
    // Attempt backtrack matching
    const pairs = this.solveBacktrackPairings(players);
    if (!pairs) {
      // Emergency fallback: greedy nearest score
      return this.greedyPairingFallback(players, roundNumber);
    }

    return pairs.map(([home, away], idx) => ({
      id: `match-${this.state.id}-r${roundNumber}-${idx + 1}`,
      round: roundNumber,
      homeParticipantId: home.id,
      awayParticipantId: away.id,
      isFinished: false,
    }));
  }

  /**
   * Backtracking solver that pairs candidates while strictly enforcing non-repeat matchups.
   */
  private solveBacktrackPairings(
    players: SwissParticipant[]
  ): Array<[SwissParticipant, SwissParticipant]> | null {
    if (players.length === 0) return [];
    if (players.length % 2 !== 0) return null;

    const first = players[0];

    // Candidate opponents in order of closeness in rank/score
    for (let i = 1; i < players.length; i++) {
      const candidate = players[i];

      // Prevent repeat matchup
      if (first.opponentsFaced.includes(candidate.id)) {
        continue;
      }

      const remaining = [
        ...players.slice(1, i),
        ...players.slice(i + 1),
      ];

      const subResult = this.solveBacktrackPairings(remaining);
      if (subResult !== null) {
        return [[first, candidate], ...subResult];
      }
    }

    // If strictly unavoidable, allow repeat matchup as emergency fallback
    return null;
  }

  /**
   * Fallback pairing when a strict zero-repeat solution is mathematically impossible.
   */
  private greedyPairingFallback(
    players: SwissParticipant[],
    roundNumber: number
  ): SwissMatchup[] {
    const remaining = [...players];
    const matchups: SwissMatchup[] = [];
    let matchIdx = 1;

    while (remaining.length >= 2) {
      const p1 = remaining.shift()!;
      // Find opponent with lowest prior match count against p1
      let bestIdx = 0;
      let minRepeats = Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const p2 = remaining[i];
        const repeats = p1.opponentsFaced.filter((id) => id === p2.id).length;
        if (repeats < minRepeats) {
          minRepeats = repeats;
          bestIdx = i;
          if (repeats === 0) break;
        }
      }

      const p2 = remaining.splice(bestIdx, 1)[0];
      matchups.push({
        id: `match-${this.state.id}-r${roundNumber}-${matchIdx++}`,
        round: roundNumber,
        homeParticipantId: p1.id,
        awayParticipantId: p2.id,
        isFinished: false,
      });
    }

    return matchups;
  }

  /**
   * Submits round scores and resolves matches, updating standings.
   */
  public submitRoundResults(
    roundNumber: number,
    results: Array<{
      homeParticipantId: string;
      awayParticipantId: string | null;
      homeScore: number;
      awayScore: number;
    }>
  ): void {
    if (this.state.status !== "ROUND_ACTIVE") {
      throw new Error("Round results can only be submitted for an active round.");
    }
    if (this.state.currentRound !== roundNumber) {
      throw new Error(
        `Invalid round submission. Current round is ${this.state.currentRound}, submitted ${roundNumber}.`
      );
    }

    const round = this.getCurrentRound();
    if (!round) {
      throw new Error(`Round ${roundNumber} not found.`);
    }

    const expectedMatchups = round.matchups.filter((matchup) => matchup.awayParticipantId !== null);
    const expectedKeys = new Set(expectedMatchups.map((matchup) =>
      [matchup.homeParticipantId, matchup.awayParticipantId!].sort().join("\u0000")
    ));
    const submittedKeys = new Set<string>();
    for (const result of results) {
      if (result.awayParticipantId === null) {
        throw new Error("Bye results are recorded automatically and must not be submitted.");
      }
      if (!Number.isFinite(result.homeScore) || !Number.isFinite(result.awayScore) || result.homeScore < 0 || result.awayScore < 0) {
        throw new Error("Match scores must be finite, non-negative numbers.");
      }
      const key = [result.homeParticipantId, result.awayParticipantId].sort().join("\u0000");
      if (!expectedKeys.has(key)) {
        throw new Error("Results include a matchup that is not part of the active round.");
      }
      if (submittedKeys.has(key)) {
        throw new Error("Each matchup can only be submitted once per round.");
      }
      submittedKeys.add(key);
    }
    if (submittedKeys.size !== expectedKeys.size) {
      throw new Error("Results must be provided for every non-bye matchup in the round.");
    }

    for (const res of results) {
      let isReversed = false;
      let matchup = round.matchups.find(
        (m) =>
          m.homeParticipantId === res.homeParticipantId &&
          m.awayParticipantId === res.awayParticipantId
      );

      if (!matchup) {
        matchup = round.matchups.find(
          (m) =>
            m.homeParticipantId === res.awayParticipantId &&
            m.awayParticipantId === res.homeParticipantId
        );
        if (matchup) {
          isReversed = true;
        }
      }

      if (!matchup) continue;

      const homeScore = isReversed ? res.awayScore : res.homeScore;
      const awayScore = isReversed ? res.homeScore : res.awayScore;
      matchup.homeScore = homeScore;
      matchup.awayScore = awayScore;
      matchup.isFinished = true;

      const home = this.state.participants[matchup.homeParticipantId];
      const away = matchup.awayParticipantId
        ? this.state.participants[matchup.awayParticipantId]
        : null;

      if (!home) continue;

      home.pointsFor += homeScore;
      home.pointsAgainst += awayScore;

      if (away) {
        away.pointsFor += awayScore;
        away.pointsAgainst += homeScore;

        home.opponentsFaced.push(away.id);
        away.opponentsFaced.push(home.id);

        if (homeScore > awayScore) {
          matchup.winnerId = home.id;
          home.wins += 1;
          home.matchPoints += 3;
          away.losses += 1;
          home.matchHistory.push({
            round: roundNumber,
            opponentId: away.id,
            result: "WIN",
            score: homeScore,
            opponentScore: awayScore,
          });
          away.matchHistory.push({
            round: roundNumber,
            opponentId: home.id,
            result: "LOSS",
            score: awayScore,
            opponentScore: homeScore,
          });
        } else if (homeScore < awayScore) {
          matchup.winnerId = away.id;
          away.wins += 1;
          away.matchPoints += 3;
          home.losses += 1;
          home.matchHistory.push({
            round: roundNumber,
            opponentId: away.id,
            result: "LOSS",
            score: homeScore,
            opponentScore: awayScore,
          });
          away.matchHistory.push({
            round: roundNumber,
            opponentId: home.id,
            result: "WIN",
            score: awayScore,
            opponentScore: homeScore,
          });
        } else {
          // Draw
          matchup.winnerId = null;
          home.draws += 1;
          home.matchPoints += 1;
          away.draws += 1;
          away.matchPoints += 1;
          home.matchHistory.push({
            round: roundNumber,
            opponentId: away.id,
            result: "DRAW",
            score: homeScore,
            opponentScore: awayScore,
          });
          away.matchHistory.push({
            round: roundNumber,
            opponentId: home.id,
            result: "DRAW",
            score: awayScore,
            opponentScore: homeScore,
          });
        }
      }
    }

    round.isFinished = true;
    this.recomputeStandingsAndTieBreakers();

    if (this.state.currentRound >= this.state.totalRounds) {
      this.state.status = "TOURNAMENT_COMPLETED";
    } else {
      this.state.status = "ROUND_COMPLETED";
    }

    this.state.updatedAt = new Date();
  }
}
