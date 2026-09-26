/**
 * Shared TypeScript types and enums for the FantasyXI backend.
 *
 * These mirror the Prisma schema enums and define request/response shapes
 * used across controllers, services, and middleware.
 *
 * Laravel equivalent: These are like Form Request validation types +
 * API Resource shapes combined.
 */

// ============================================================
// Enums — must match the Prisma schema exactly
// ============================================================

import {
  Position,
  LeagueStatus,
  MembershipStatus,
  PaymentStatus,
  ScoringType,
  TransactionType,
  TransactionStatus,
  ChipType,
  UserRole,
} from "@prisma/client";

export { Role, Permission } from "../config/permissions.js";
import type { Role } from "../config/permissions.js";

export {
  Position,
  LeagueStatus,
  MembershipStatus,
  PaymentStatus,
  ScoringType,
  TransactionType,
  TransactionStatus,
  ChipType,
  UserRole,
};




// ============================================================
// Squad composition constants
// ============================================================

export const SQUAD_RULES = {
  /** Total number of players in a full squad */
  TOTAL_PLAYERS: 15,
  /** Number of starting players */
  STARTERS: 11,
  /** Number of bench players */
  BENCH: 4,
  /** Required count per position */
  POSITION_COUNTS: {
    [Position.GKP]: 2,
    [Position.DEF]: 5,
    [Position.MID]: 5,
    [Position.FWD]: 3,
  } as const,
  /** Minimum starters per position (for valid formations) */
  MIN_STARTERS: {
    [Position.GKP]: 1,
    [Position.DEF]: 3,
    [Position.MID]: 2,
    [Position.FWD]: 1,
  } as const,
  /** Maximum players from a single Premier League team */
  MAX_PER_TEAM: 3,
  /** Starting budget in £ millions */
  STARTING_BUDGET: 100.0,
  /** Free transfers granted each gameweek */
  FREE_TRANSFERS_PER_GAMEWEEK: 1,
  /** Maximum free transfers that can be banked */
  MAX_FREE_TRANSFERS: 5,
  /** Points deducted per transfer beyond the free allowance */
  TRANSFER_POINTS_COST: 4,
} as const;

// ============================================================
// Authentication & User Types
// ============================================================

/** Authenticated user identity attached to Express Request (req.user) */
export interface AuthUser {
  id: string;
  email: string;
  username: string;
  name?: string | null;
  /** USER / MODERATOR / ADMIN for accounts, SERVICE for API-key callers */
  role: Role;
}

/** Safe user representation returned across public and auth endpoints */
export interface SafeUser {
  id: string;
  email: string;
  username: string;
  name?: string | null;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

/** Shape of a JWT payload after decoding */
export interface JwtPayload {
  userId: string;
  email: string;
  username: string;
  role?: UserRole;
}

/** POST /api/v1/auth/register input */
export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
  username?: string;
  referralCode?: string;
}

/** Backwards-compatible alias */
export type RegisterRequest = RegisterInput;

/** POST /api/v1/auth/login input */
export interface LoginInput {
  email: string;
  password: string;
}

/** Backwards-compatible alias */
export type LoginRequest = LoginInput;

/** Auth response payload containing safe user and token */
export interface AuthResult {
  user: SafeUser;
  token: string;
}

/** Standard auth API response wrapper */
export interface AuthResponse {
  success: boolean;
  token: string;
  user: SafeUser;
}

/** Standard API error response */
export interface ApiErrorResponse {
  success: false;
  message: string;
  errors?: Record<string, string[]>;
}

/** Standard API success response */
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

// ============================================================
// Fixture & Fantasy Squad Input Types
// ============================================================

export interface FixtureData {
  id: number;
  fplId: number;
  gameweekId: number | null;
  homeTeamId: number;
  awayTeamId: number;
  kickoffTime: string | null;
  started: boolean;
  finished: boolean;
  homeScore: number | null;
  awayScore: number | null;
  minutes: number;
}

export interface SquadPlayerSelection {
  playerId: number;
  isStarter: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
  positionOrder: number; // 1 to 15
}

export interface CreateSquadInput {
  name: string;
  userId: string;
  players: SquadPlayerSelection[];
}

export interface UpdateSquadInput {
  name?: string;
  players: SquadPlayerSelection[];
}

export interface PlayerFilterQuery {
  search?: string;
  position?: Position;
  teamId?: number;
  minPrice?: number;
  maxPrice?: number;
  isAvailable?: boolean;
  sortBy?: "price" | "totalPoints" | "goalsScored" | "assists" | "form";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}

// ============================================================
// League & Competition Types
// ============================================================

export interface CreateLeagueInput {
  name: string;
  description?: string;
  entryFee: number; // in USDC, >= 0
  maxMembers?: number; // default 20
  minMembers?: number; // default 2
  startGameweekId: number;
  endGameweekId: number;
  squadId: string; // Creator's initial squad
  scoringType?: ScoringType; // default CLASSIC
  isPrivate?: boolean; // default false: private leagues are invitation-only
}

export type LeagueSortField = "newest" | "entryFee" | "size" | "prizePool" | "members";

/** League discovery filters (GET /leagues query string) */
export interface LeagueSearchFilters {
  /** Case-insensitive substring match on the league name */
  q?: string;
  /** Exact invite code (public leagues, or private ones the viewer already belongs to) */
  code?: string;
  status?: LeagueStatus;
  scoringType?: ScoringType;
  creatorId?: string;
  minEntryFee?: number;
  maxEntryFee?: number;
  /** League capacity (maxMembers) bounds */
  minSize?: number;
  maxSize?: number;
  /** Only leagues with at least one free spot */
  hasOpenSlots?: boolean;
  sortBy?: LeagueSortField;
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface JoinLeagueInput {
  squadId: string;
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
  joinedAt: Date;
}

export interface H2HStandingsEntry {
  rank: number;
  memberId: string;
  userId: string;
  username: string;
  squadName: string;
  matchesWon: number;
  matchesDrawn: number;
  matchesLost: number;
  pointsFor: number;
  pointsAgainst: number;
  pointsDifference: number;
  h2hPoints: number;
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

// ============================================================
// Financial & Stellar Escrow Types
// ============================================================

export interface PaymentRequirement {
  leagueId: string;
  leagueName: string;
  entryFee: number; // in USDC
  assetCode: string; // e.g. "USDC"
  assetIssuer?: string;
  destinationAddress: string; // Escrow contract or platform treasury address
  escrowContractId?: string;
  memo: string; // Deterministic identifier (e.g. "LEAGUE:<id>:USER:<id>")
  paymentStatus: PaymentStatus;
}

export interface PaymentSubmissionInput {
  stellarTxHash: string;
  stellarAddress: string;
}

export interface PaymentVerificationResult {
  success: boolean;
  txHash: string;
  ledgerSeq?: number;
  amount?: number;
  assetCode?: string;
  senderAddress?: string;
  destinationAddress?: string;
  confirmedAt?: Date;
  error?: string;
}

export interface SettlementWinner {
  rank: number;
  userId: string;
  username: string;
  stellarAddress: string;
  squadName: string;
  totalPoints: number;
  prizeAmount: number; // in USDC
}

export interface SettlementPlan {
  leagueId: string;
  leagueName: string;
  status: LeagueStatus;
  totalParticipants: number;
  entryFee: number;
  grossPool: number;
  platformFee: number;
  netPrizePool: number;
  winners: SettlementWinner[];
  canSettle: boolean;
  proofHash?: string;
  unsettledReason?: string;
}

export interface ReconciliationReport {
  leagueId: string;
  leagueName: string;
  activeMemberCount: number;
  entryFee: number;
  expectedGross: number;
  confirmedDepositsTotal: number;
  discrepancy: number;
  isBalanced: boolean;
  transactions: Array<{
    id: string;
    type: TransactionType;
    status: TransactionStatus;
    amount: number;
    stellarTxHash: string | null;
    confirmedAt: Date | null;
  }>;
}




