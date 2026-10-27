/**
 * Swiss Tournament Service
 *
 * Coordinates Swiss tournament state machines for leagues.
 */

import {
  SwissTournamentEngine,
  SwissTournamentState,
  SwissParticipant,
  SwissRound,
} from "./swissTournamentEngine.js";

// In-memory registry of active Swiss tournament engines (backed by cache / db)
const tournamentStore = new Map<string, SwissTournamentEngine>();

export class SwissTournamentService {
  /**
   * Initializes a Swiss tournament stage for a league.
   */
  public static createTournament(
    leagueId: string,
    participants: Array<{ id: string; name?: string; seed?: number }>,
    totalRounds?: number
  ): SwissTournamentState {
    if (participants.length < 2) {
      throw new Error("A tournament requires at least 2 participants.");
    }

    const engine = new SwissTournamentEngine({
      leagueId,
      participants,
      totalRounds,
    });

    tournamentStore.set(leagueId, engine);
    return engine.getState();
  }

  public static getEngine(leagueId: string): SwissTournamentEngine {
    const engine = tournamentStore.get(leagueId);
    if (!engine) {
      throw new Error(`No active Swiss tournament found for league ${leagueId}.`);
    }
    return engine;
  }

  public static getStandings(leagueId: string): SwissParticipant[] {
    const engine = this.getEngine(leagueId);
    return engine.getStandings();
  }

  public static getCurrentRound(leagueId: string): SwissRound | null {
    const engine = this.getEngine(leagueId);
    return engine.getCurrentRound();
  }

  public static startOrAdvanceRound(
    leagueId: string,
    gameweekId: number
  ): SwissRound {
    const engine = this.getEngine(leagueId);
    return engine.generateNextRound(gameweekId);
  }

  public static submitRoundResults(
    leagueId: string,
    roundNumber: number,
    results: Array<{
      homeParticipantId: string;
      awayParticipantId: string | null;
      homeScore: number;
      awayScore: number;
    }>
  ): SwissTournamentState {
    const engine = this.getEngine(leagueId);
    engine.submitRoundResults(roundNumber, results);
    return engine.getState();
  }

  public static clearStore(): void {
    tournamentStore.clear();
  }
}
