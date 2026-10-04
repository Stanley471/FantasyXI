import { Position } from "../../types/index.js";

/**
 * Normalization layer for raw FPL API data.
 *
 * Keeps our application independent of FPL's internal naming conventions
 * (e.g. FPL uses element_type 1..4, now_cost in tenths of £1m, etc.).
 *
 * Laravel equivalent: Like a dedicated Data Transfer Object (DTO) or
 * API transformer class (e.g. FplTeamTransformer, FplPlayerTransformer).
 */

/**
 * Maps FPL element_type integer to our domain Position enum:
 * 1 -> GKP (Goalkeeper)
 * 2 -> DEF (Defender)
 * 3 -> MID (Midfielder)
 * 4 -> FWD (Forward)
 */
export function normalizeElementType(elementType: number): Position {
  switch (elementType) {
    case 1:
      return Position.GKP;
    case 2:
      return Position.DEF;
    case 3:
      return Position.MID;
    case 4:
      return Position.FWD;
    default:
      throw new Error(`Unknown FPL element_type: ${elementType}`);
  }
}

/**
 * FPL stores costs as an integer in tenths of a million (e.g. 105 = £10.5m).
 * Returns a number rounded to 1 decimal place.
 */
export function normalizePrice(nowCost: number): number {
  if (typeof nowCost !== "number" || isNaN(nowCost)) {
    return 0.0;
  }
  return Math.round(nowCost) / 10.0;
}

export interface NormalizedTeam {
  fplId: number;
  name: string;
  shortName: string;
  logoUrl: string | null;
  strength?: number | null;
  strengthOverallHome?: number | null;
  strengthOverallAway?: number | null;
  strengthAttackHome?: number | null;
  strengthAttackAway?: number | null;
  strengthDefenceHome?: number | null;
  strengthDefenceAway?: number | null;
}

export function normalizeTeam(raw: {
  id: number;
  name: string;
  short_name: string;
  strength?: number;
  strength_overall_home?: number;
  strength_overall_away?: number;
  strength_attack_home?: number;
  strength_attack_away?: number;
  strength_defence_home?: number;
  strength_defence_away?: number;
}): NormalizedTeam {
  return {
    fplId: raw.id,
    name: raw.name?.trim() || `Team ${raw.id}`,
    shortName: raw.short_name?.trim() || `T${raw.id}`,
    logoUrl: `https://resources.premierleague.com/premierleague/badges/70/t${raw.id}.png`,
    strength: raw.strength ?? null,
    strengthOverallHome: raw.strength_overall_home ?? null,
    strengthOverallAway: raw.strength_overall_away ?? null,
    strengthAttackHome: raw.strength_attack_home ?? null,
    strengthAttackAway: raw.strength_attack_away ?? null,
    strengthDefenceHome: raw.strength_defence_home ?? null,
    strengthDefenceAway: raw.strength_defence_away ?? null,
  };
}

export interface NormalizedPlayer {
  fplId: number;
  firstName: string;
  lastName: string;
  displayName: string;
  position: Position;
  price: number;
  totalPoints: number;
  minutesPlayed: number;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  form: number | null;
  status: string;
  news: string | null;
  chanceOfPlayingNextRound: number | null;
  selectedByPercent: number | null;
  photoUrl: string | null;
  isAvailable: boolean;
}

export function normalizePlayer(raw: {
  id: number;
  first_name: string;
  second_name: string;
  web_name: string;
  element_type: number;
  now_cost: number;
  total_points: number;
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  form?: string;
  status?: string;
  news?: string;
  chance_of_playing_next_round?: number | null;
  selected_by_percent?: string;
  photo?: string;
}): NormalizedPlayer {
  const status = raw.status || "a";
  const isAvailable = status === "a";
  const photoCode = raw.photo ? raw.photo.replace(".jpg", "") : null;
  const photoUrl = photoCode
    ? `https://resources.premierleague.com/premierleague/photos/players/110x140/p${photoCode}.png`
    : null;

  return {
    fplId: raw.id,
    firstName: raw.first_name?.trim() || "",
    lastName: raw.second_name?.trim() || "",
    displayName: raw.web_name?.trim() || `${raw.first_name} ${raw.second_name}`,
    position: normalizeElementType(raw.element_type),
    price: normalizePrice(raw.now_cost),
    totalPoints: raw.total_points ?? 0,
    minutesPlayed: raw.minutes ?? 0,
    goalsScored: raw.goals_scored ?? 0,
    assists: raw.assists ?? 0,
    cleanSheets: raw.clean_sheets ?? 0,
    form: raw.form ? parseFloat(raw.form) : null,
    status,
    news: raw.news?.trim() || null,
    chanceOfPlayingNextRound: raw.chance_of_playing_next_round ?? null,
    selectedByPercent: raw.selected_by_percent
      ? parseFloat(raw.selected_by_percent)
      : null,
    photoUrl,
    isAvailable,
  };
}

export interface NormalizedGameweek {
  fplId: number;
  name: string;
  deadline: Date;
  isCurrent: boolean;
  isFinished: boolean;
  season: string;
}

export function normalizeGameweek(
  raw: {
    id: number;
    name: string;
    deadline_time: string;
    is_current: boolean;
    finished: boolean;
  },
  season: string = "2025/26"
): NormalizedGameweek {
  return {
    fplId: raw.id,
    name: raw.name || `Gameweek ${raw.id}`,
    deadline: new Date(raw.deadline_time),
    isCurrent: Boolean(raw.is_current),
    isFinished: Boolean(raw.finished),
    season,
  };
}

export interface NormalizedFixture {
  fplId: number;
  homeTeamFplId: number;
  awayTeamFplId: number;
  gameweekFplId: number | null;
  kickoffTime: Date | null;
  started: boolean;
  finished: boolean;
  homeScore: number | null;
  awayScore: number | null;
  minutes: number;
}

export function normalizeFixture(raw: {
  id: number;
  event: number | null;
  team_h: number;
  team_a: number;
  kickoff_time: string | null;
  started: boolean;
  finished: boolean;
  team_h_score: number | null;
  team_a_score: number | null;
  minutes: number;
}): NormalizedFixture {
  return {
    fplId: raw.id,
    gameweekFplId: raw.event ?? null,
    homeTeamFplId: raw.team_h,
    awayTeamFplId: raw.team_a,
    kickoffTime: raw.kickoff_time ? new Date(raw.kickoff_time) : null,
    started: Boolean(raw.started),
    finished: Boolean(raw.finished),
    homeScore: raw.team_h_score ?? null,
    awayScore: raw.team_a_score ?? null,
    minutes: raw.minutes ?? 0,
  };
}

export interface NormalizedPlayerStats {
  playerFplId: number;
  fixtureFplId: number;
  minutes: number;
  goals: number;
  assists: number;
  cleanSheet: boolean;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  totalPoints: number;
}

export function normalizePlayerStats(raw: {
  id: number;
  stats: {
    minutes: number;
    goals_scored: number;
    assists: number;
    clean_sheets: number;
    yellow_cards: number;
    red_cards: number;
    saves: number;
    bonus: number;
    total_points: number;
  };
  explain: Array<{
    fixture: number;
    stats: Array<{
      identifier: string;
      points: number;
      value: number;
    }>;
  }>;
}): NormalizedPlayerStats[] {
  return raw.explain.map((exp) => {
    let minutes = 0;
    let goals = 0;
    let assists = 0;
    let cleanSheet = false;
    let yellowCards = 0;
    let redCards = 0;
    let saves = 0;
    let bonus = 0;
    let totalPoints = 0;

    for (const stat of exp.stats) {
      totalPoints += stat.points;
      switch (stat.identifier) {
        case "minutes":
          minutes = stat.value;
          break;
        case "goals_scored":
          goals = stat.value;
          break;
        case "assists":
          assists = stat.value;
          break;
        case "clean_sheets":
          cleanSheet = stat.value > 0;
          break;
        case "yellow_cards":
          yellowCards = stat.value;
          break;
        case "red_cards":
          redCards = stat.value;
          break;
        case "saves":
          saves = stat.value;
          break;
        case "bonus":
          bonus = stat.value;
          break;
      }
    }

    return {
      playerFplId: raw.id,
      fixtureFplId: exp.fixture,
      minutes,
      goals,
      assists,
      cleanSheet,
      yellowCards,
      redCards,
      saves,
      bonus,
      totalPoints,
    };
  });
}
