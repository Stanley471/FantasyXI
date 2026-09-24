/**
 * Shared TypeScript types for the FantasyXI frontend.
 *
 * These describe the shape of data coming back from the backend API.
 * They mirror the backend Prisma models but only include fields the
 * frontend actually needs (no password hashes, etc.).
 *
 * Laravel equivalent: Think of these like API Resources — they define
 * what the JSON response looks like, not what the database stores.
 */

// ============================================================
// Enums — must match backend exactly
// ============================================================

export enum Position {
  GKP = "GKP",
  DEF = "DEF",
  MID = "MID",
  FWD = "FWD",
}

export enum LeagueStatus {
  UPCOMING = "UPCOMING",
  ACTIVE = "ACTIVE",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
}

export enum MembershipStatus {
  PENDING = "PENDING",
  ACTIVE = "ACTIVE",
  CANCELLED = "CANCELLED",
  REFUNDED = "REFUNDED",
}

export enum ScoringType {
  CLASSIC = "CLASSIC",
  HEAD_TO_HEAD = "HEAD_TO_HEAD",
}

export enum TransactionType {
  DEPOSIT = "DEPOSIT",
  WITHDRAWAL = "WITHDRAWAL",
  ENTRY_FEE = "ENTRY_FEE",
  PRIZE = "PRIZE",
}

export enum TransactionStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  FAILED = "FAILED",
}

// ============================================================
// API response types
// ============================================================

export interface User {
  id: string;
  email: string;
  username: string;
  name?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface Team {
  id: number;
  fplId: number;
  name: string;
  shortName: string;
  logoUrl: string | null;
  strength?: number | null;
  strengthOverallHome?: number | null;
  strengthOverallAway?: number | null;
}

export interface Player {
  id: number;
  fplId: number;
  firstName: string;
  lastName: string;
  displayName: string;
  position: Position;
  teamId: number;
  team?: Team;
  price: number;
  totalPoints: number;
  minutesPlayed: number;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  form?: number | null;
  status?: string | null;
  news?: string | null;
  chanceOfPlayingNextRound?: number | null;
  selectedByPercent?: number | null;
  photoUrl: string | null;
  isAvailable: boolean;
}

export interface Fixture {
  id: number;
  fplId: number;
  gameweekId: number | null;
  gameweek?: Gameweek;
  homeTeamId: number;
  homeTeam?: Team;
  awayTeamId: number;
  awayTeam?: Team;
  kickoffTime: string | null;
  started: boolean;
  finished: boolean;
  homeScore: number | null;
  awayScore: number | null;
  minutes: number;
}

export interface Gameweek {
  id: number;
  fplId: number;
  name: string;
  deadline: string;
  isCurrent: boolean;
  isFinished: boolean;
  season: string;
}

export interface PlayerGameweekStats {
  id: number;
  playerId: number;
  gameweekId: number;
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

export interface Squad {
  id: string;
  userId: string;
  name: string;
  budgetRemaining: number;
  totalPoints: number;
  players?: SquadPlayer[];
  createdAt: string;
}

export interface SquadPlayer {
  id: number;
  squadId: string;
  playerId: number;
  player?: Player;
  isCaptain: boolean;
  isViceCaptain: boolean;
  isStarter: boolean;
  positionOrder: number;
  purchasePrice: number;
}

export interface League {
  id: string;
  name: string;
  description: string | null;
  creatorId: string;
  inviteCode: string;
  maxMembers: number;
  minMembers: number;
  currentMembers: number;
  entryFee: number;
  prizePool: number;
  status: LeagueStatus;
  scoringType: ScoringType;
  startGameweekId: number;
  endGameweekId: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeagueMember {
  id: string;
  leagueId: string;
  userId: string;
  user?: User;
  squadId: string;
  squad?: Squad;
  status: MembershipStatus;
  hasPaid: boolean;
  rank: number | null;
  totalPoints: number;
  joinedAt: string;
}

export interface LeagueStandingsEntry {
  rank: number;
  userId: string;
  username: string;
  squadId: string;
  squadName: string;
  membershipStatus: MembershipStatus;
  totalPoints: number;
  bestGameweekPoints: number;
  gameweekScores: Array<{
    gameweekId: number;
    gameweekName: string;
    points: number;
  }>;
  joinedAt: string;
}

// ============================================================
// Live Matchday Feed (GET /api/v1/leagues/:id/live, Server-Sent Events)
// ============================================================

export interface LivePlayerPoints {
  playerId: number;
  name: string;
  teamShortName: string;
  position: Position;
  isStarter: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
  positionOrder: number;
  minutesPlayed: number;
  rawPoints: number;
  multiplier: number;
  effectivePoints: number;
  subbedIn: boolean;
  subbedOut: boolean;
}

export interface LiveStandingsEntry {
  rank: number;
  userId: string;
  username: string;
  squadId: string;
  squadName: string;
  membershipStatus: MembershipStatus;
  totalPoints: number;
  livePoints: number;
  lineup: LivePlayerPoints[];
}

export interface LiveFixture {
  id: number;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  minutes: number;
  started: boolean;
  finished: boolean;
  kickoffTime: string | null;
}

export interface LivePlayerEvent {
  playerId: number;
  playerName: string;
  teamShortName: string;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  totalPoints: number;
}

export interface LiveSnapshot {
  leagueId: string;
  gameweek: { id: number; name: string } | null;
  fixtures: LiveFixture[];
  events: LivePlayerEvent[];
  standings: LiveStandingsEntry[];
  generatedAt: string;
}

export interface PrizeDistribution {
  participantCount: number;
  entryFee: number;
  grossTotal: number;
  platformFee: number;
  prizePool: number;
  prizes: {
    first: number;
    second: number;
    third: number;
  };
}

export interface Transaction {
  id: string;
  userId: string;
  leagueId: string | null;
  type: TransactionType;
  amount: number;
  stellarTxHash: string | null;
  status: TransactionStatus;
  createdAt: string;
}

// ============================================================
// API wrapper types
// ============================================================

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  errors?: Record<string, string[]>;
}

export interface AuthResponse {
  success: true;
  token: string;
  user: User;
}

// ============================================================
// Squad composition constants (mirrors backend)
// ============================================================

export const SQUAD_RULES = {
  TOTAL_PLAYERS: 15,
  STARTERS: 11,
  BENCH: 4,
  POSITION_COUNTS: {
    [Position.GKP]: 2,
    [Position.DEF]: 5,
    [Position.MID]: 5,
    [Position.FWD]: 3,
  } as const,
  MIN_STARTERS: {
    [Position.GKP]: 1,
    [Position.DEF]: 3,
    [Position.MID]: 2,
    [Position.FWD]: 1,
  } as const,
  MAX_PER_TEAM: 3,
  STARTING_BUDGET: 100.0,
} as const;

// ============================================================
// Live Match Event Timeline Types
// ============================================================

export type MatchEventType =
  | "GOAL"
  | "ASSIST"
  | "YELLOW_CARD"
  | "RED_CARD"
  | "SAVE"
  | "BONUS"
  | "PENALTY_SAVED"
  | "OWN_GOAL";

export interface TimelineEvent {
  id: string;
  fixtureId: number;
  fixtureName: string;
  gameweekId: number;
  playerId: number;
  fplId: number;
  playerName: string;
  teamShortName: string;
  teamId: number;
  type: MatchEventType;
  minute: number;
  detail: string;
  pointsAwarded: number;
  timestamp: string;
}

export interface FixtureTimelineSummary {
  id: number;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  minutes: number;
  started: boolean;
  finished: boolean;
  kickoffTime: string | null;
  events: TimelineEvent[];
}

export interface GameweekTimeline {
  gameweek: {
    id: number;
    name: string;
    isCurrent: boolean;
    isFinished: boolean;
  } | null;
  fixtures: FixtureTimelineSummary[];
  events: TimelineEvent[];
  summary: {
    totalGoals: number;
    totalAssists: number;
    totalYellowCards: number;
    totalRedCards: number;
    totalSaves: number;
    totalBonus: number;
  };
  generatedAt: string;
}

