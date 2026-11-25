/**
 * Fixture Difficulty Analytics & Matrix Builder
 *
 * Analyzes fixture difficulty ratings (FDR) and constructs difficulty matrices
 * for the next 5 gameweeks, with color-coding and filtering capabilities.
 */

import { Team } from "@/types";

export interface TeamFixture {
  gameweekId: number;
  gameweekName: string;
  opponentTeamId: number;
  opponentTeamName: string;
  isHome: boolean;
  difficulty: number; // 1-5 scale
  difficultyRating: "Very Easy" | "Easy" | "Medium" | "Hard" | "Very Hard";
}

export interface TeamFixtureDifficulty {
  teamId: number;
  teamName: string;
  teamShortName: string;
  fixtures: TeamFixture[];
  aggregateDifficulty: number;
  easyFixtures: number;
  hardFixtures: number;
}

export interface DifficultyMatrixCell {
  teamId: number;
  teamName: string;
  gameweekId: number;
  gameweekName: string;
  difficulty: number;
  difficultyRating: string;
  isHome: boolean;
  opponentTeamName: string;
  color: string;
}

export interface DifficultyMatrix {
  gameweeks: Array<{ id: number; name: string }>;
  teams: Pick<Team, "id" | "name" | "shortName">[];
  cells: DifficultyMatrixCell[];
  averageDifficulty: number;
}

export interface FixtureWindow {
  startGameweekId: number;
  endGameweekId: number;
  gameweekCount: number;
  fixtures: TeamFixtureDifficulty[];
}

/**
 * Build fixture difficulty matrix for a 5-gameweek window
 */
export function buildFixtureDifficultyMatrix(
  fixtures: TeamFixture[],
  teams: Pick<Team, "id" | "name" | "shortName">[],
  startGameweek: number,
  gameweekWindow: number = 5
): DifficultyMatrix {
  // Filter to window
  const windowFixtures = fixtures.filter(
    (f) => f.gameweekId >= startGameweek && f.gameweekId < startGameweek + gameweekWindow
  );

  // Get unique gameweeks in order
  const gameweeks = Array.from(
    new Map(
      [...new Set(windowFixtures.map((f) => f.gameweekId))]
        .sort()
        .map((id) => [id, windowFixtures.find((f) => f.gameweekId === id)])
    ).values()
  ).map((f) => f!) as TeamFixture[];

  const gameweekSet = Array.from(new Set(windowFixtures.map((f) => f.gameweekId))).sort();

  // Build cells
  const cells: DifficultyMatrixCell[] = [];

  for (const team of teams) {
    for (const gwId of gameweekSet) {
      const fixture = windowFixtures.find(
        (f) => f.teamId === team.id && f.gameweekId === gwId
      );

      if (fixture) {
        cells.push({
          teamId: team.id,
          teamName: team.name,
          gameweekId: gwId,
          gameweekName: fixture.gameweekName,
          difficulty: fixture.difficulty,
          difficultyRating: fixture.difficultyRating,
          isHome: fixture.isHome,
          opponentTeamName: fixture.opponentTeamName,
          color: getDifficultyColor(fixture.difficulty),
        });
      }
    }
  }

  // Calculate average difficulty
  const avgDifficulty =
    cells.length > 0
      ? cells.reduce((sum, c) => sum + c.difficulty, 0) / cells.length
      : 0;

  return {
    gameweeks: gameweekSet.map((id) => {
      const gw = windowFixtures.find((f) => f.gameweekId === id);
      return { id, name: gw?.gameweekName || `GW${id}` };
    }),
    teams: teams,
    cells,
    averageDifficulty: Math.round(avgDifficulty * 100) / 100,
  };
}

/**
 * Get color for difficulty rating (5-point scale)
 * 1 = Very Easy (green), 5 = Very Hard (red)
 */
export function getDifficultyColor(difficulty: number): string {
  switch (difficulty) {
    case 1:
      return "#10b981"; // Emerald - Very Easy
    case 2:
      return "#6ee7b7"; // Light Emerald - Easy
    case 3:
      return "#f59e0b"; // Amber - Medium
    case 4:
      return "#f87171"; // Light Red - Hard
    case 5:
      return "#dc2626"; // Red - Very Hard
    default:
      return "#e5e7eb"; // Gray
  }
}

/**
 * Get difficulty label for numeric rating
 */
export function getDifficultyLabel(difficulty: number): string {
  switch (difficulty) {
    case 1:
      return "Very Easy";
    case 2:
      return "Easy";
    case 3:
      return "Medium";
    case 4:
      return "Hard";
    case 5:
      return "Very Hard";
    default:
      return "Unknown";
  }
}

/**
 * Analyze fixture swings (changes in difficulty) across gameweeks
 */
export function analyzeFixtureSwings(
  teamId: number,
  fixtures: TeamFixture[]
): FixtureSwing[] {
  const teamFixtures = fixtures
    .filter((f) => f.teamId === teamId)
    .sort((a, b) => a.gameweekId - b.gameweekId);

  const swings: FixtureSwing[] = [];

  for (let i = 1; i < teamFixtures.length; i++) {
    const prev = teamFixtures[i - 1];
    const curr = teamFixtures[i];
    const swing = curr.difficulty - prev.difficulty;

    swings.push({
      fromGameweek: prev.gameweekId,
      toGameweek: curr.gameweekId,
      fromDifficulty: prev.difficulty,
      toDifficulty: curr.difficulty,
      swing,
      swingType: swing > 0 ? "harder" : swing < 0 ? "easier" : "same",
      impactScore: Math.abs(swing),
    });
  }

  return swings;
}

export interface FixtureSwing {
  fromGameweek: number;
  toGameweek: number;
  fromDifficulty: number;
  toDifficulty: number;
  swing: number;
  swingType: "harder" | "easier" | "same";
  impactScore: number;
}

/**
 * Get high-impact fixture swings
 */
export function getHighImpactSwings(
  fixtures: TeamFixture[],
  teams: Pick<Team, "id" | "name">[],
  threshold: number = 2
): Array<FixtureSwing & { teamName: string }> {
  const allSwings: Array<FixtureSwing & { teamName: string; teamId: number }> = [];

  for (const team of teams) {
    const swings = analyzeFixtureSwings(team.id, fixtures);
    for (const swing of swings) {
      if (swing.impactScore >= threshold) {
        allSwings.push({
          ...swing,
          teamId: team.id,
          teamName: team.name,
        });
      }
    }
  }

  return allSwings.sort((a, b) => b.impactScore - a.impactScore);
}

/**
 * Filter difficulty matrix by position
 */
export function filterMatrixByPosition(
  matrix: DifficultyMatrix,
  players: Array<{ id: number; teamId: number; position: string }>,
  position: string
): DifficultyMatrix {
  const teamIds = new Set(
    players.filter((p) => p.position === position).map((p) => p.teamId)
  );

  return {
    ...matrix,
    cells: matrix.cells.filter((c) => teamIds.has(c.teamId)),
    teams: matrix.teams.filter((t) => teamIds.has(t.id)),
  };
}

/**
 * Filter difficulty matrix by team(s)
 */
export function filterMatrixByTeams(
  matrix: DifficultyMatrix,
  teamIds: number[]
): DifficultyMatrix {
  const teamIdSet = new Set(teamIds);

  return {
    ...matrix,
    cells: matrix.cells.filter((c) => teamIdSet.has(c.teamId)),
    teams: matrix.teams.filter((t) => teamIdSet.has(t.id)),
  };
}

/**
 * Calculate team difficulty score (lower = easier remaining schedule)
 */
export function calculateTeamDifficultyScore(
  teamId: number,
  fixtures: TeamFixture[],
  windowStart: number,
  windowEnd: number
): number {
  const teamFixtures = fixtures.filter(
    (f) =>
      f.teamId === teamId &&
      f.gameweekId >= windowStart &&
      f.gameweekId <= windowEnd
  );

  if (teamFixtures.length === 0) return 0;

  return (
    teamFixtures.reduce((sum, f) => sum + f.difficulty, 0) /
    teamFixtures.length
  );
}

/**
 * Rank teams by difficulty (easiest schedule first)
 */
export function rankTeamsByFixtureDifficulty(
  fixtures: TeamFixture[],
  teams: Pick<Team, "id" | "name">[],
  windowStart: number,
  windowEnd: number
): Array<{ teamId: number; teamName: string; difficultyScore: number }> {
  const scores = teams.map((team) => ({
    teamId: team.id,
    teamName: team.name,
    difficultyScore: calculateTeamDifficultyScore(
      team.id,
      fixtures,
      windowStart,
      windowEnd
    ),
  }));

  return scores.sort((a, b) => a.difficultyScore - b.difficultyScore);
}

/**
 * Build summary statistics for fixture window
 */
export function getFixtureWindowSummary(
  fixtures: TeamFixture[],
  teams: Pick<Team, "id" | "name">[],
  windowStart: number,
  windowEnd: number
): FixtureSummary {
  const windowFixtures = fixtures.filter(
    (f) => f.gameweekId >= windowStart && f.gameweekId <= windowEnd
  );

  const difficultyScores = teams.map((team) =>
    calculateTeamDifficultyScore(team.id, windowFixtures, windowStart, windowEnd)
  );

  const easiestTeams = rankTeamsByFixtureDifficulty(
    windowFixtures,
    teams,
    windowStart,
    windowEnd
  ).slice(0, 3);

  const hardestTeams = rankTeamsByFixtureDifficulty(
    windowFixtures,
    teams,
    windowStart,
    windowEnd
  )
    .slice(-3)
    .reverse();

  return {
    windowStart,
    windowEnd,
    gameweekCount: windowEnd - windowStart + 1,
    averageDifficulty:
      difficultyScores.length > 0
        ? difficultyScores.reduce((a, b) => a + b) / difficultyScores.length
        : 0,
    easiestSchedules: easiestTeams,
    hardestSchedules: hardestTeams,
    totalFixtures: windowFixtures.length,
  };
}

export interface FixtureSummary {
  windowStart: number;
  windowEnd: number;
  gameweekCount: number;
  averageDifficulty: number;
  easiestSchedules: Array<{ teamId: number; teamName: string; difficultyScore: number }>;
  hardestSchedules: Array<{ teamId: number; teamName: string; difficultyScore: number }>;
  totalFixtures: number;
}
