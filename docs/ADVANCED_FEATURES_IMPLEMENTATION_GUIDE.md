# FantasyXI Advanced Features Implementation Guide

This document provides comprehensive implementation guidance for four critical features: formation solver, session management, tier transitions, and optimistic UI updates.

---

## Issue #226: Dynamic Formation Solver for Auto-Substitutions

**Problem:** Sequential bench substitution fails in complex double gameweek scenarios with multiple non-playing starters, getting trapped in formation constraints.

### Current vs. Proposed Approach

**Current (Sequential):**
```typescript
// Naive sequential approach
for (const starter of nonPlayingStarters) {
  for (const benchPlayer of bench) {
    if (canSubstitute(starter, benchPlayer)) {
      substitute(starter, benchPlayer);
      break;
    }
  }
}
// Problem: May violate formation rules or sub suboptimally
```

**Proposed (Constraint Satisfaction):**
```typescript
// Global optimization approach
const validFormations = generateAllValidFormations(squad, bench);
const bestFormation = validFormations.reduce((best, current) => 
  current.totalPoints > best.totalPoints ? current : best
);
applySubstitutions(bestFormation);
```

### Valid FPL Formations

```typescript
// backend/src/services/scoring/formationSolver.ts
export const VALID_FORMATIONS = [
  { def: 3, mid: 5, fwd: 2 }, // 3-5-2
  { def: 3, mid: 4, fwd: 3 }, // 3-4-3
  { def: 4, mid: 4, fwd: 2 }, // 4-4-2
  { def: 4, mid: 3, fwd: 3 }, // 4-3-3
  { def: 5, mid: 3, fwd: 2 }, // 5-3-2
  { def: 5, mid: 4, fwd: 1 }, // 5-4-1
  { def: 4, mid: 5, fwd: 1 }, // 4-5-1
  { def: 5, mid: 2, fwd: 3 }, // 5-2-3
] as const;

export interface FormationConstraints {
  minDef: 3;
  maxDef: 5;
  minMid: 2;
  maxMid: 5;
  minFwd: 1;
  maxFwd: 3;
  totalOutfield: 10; // GKP + 10 outfield
}
```

### Formation Solver Implementation

```typescript
// backend/src/services/scoring/formationSolver.ts
import { Player, Position } from '@prisma/client';

export interface SubstitutionCandidate {
  starter: Player;
  benchPlayer: Player;
  pointsGained: number;
}

export interface FormationSolution {
  finalLineup: Player[];
  substitutions: SubstitutionCandidate[];
  formation: { def: number; mid: number; fwd: number };
  totalPoints: number;
  isValid: boolean;
}

export class FormationSolver {
  /**
   * Find optimal substitutions respecting all FPL constraints
   * 
   * Algorithm:
   * 1. Identify non-playing starters (0 minutes)
   * 2. Generate all valid formation permutations
   * 3. For each formation, try all bench permutations
   * 4. Return formation with maximum total points
   */
  static solve(
    goalkeeper: Player,
    starters: Player[],
    bench: Player[],
    nonPlayingStarters: Player[]
  ): FormationSolution {
    if (nonPlayingStarters.length === 0) {
      return {
        finalLineup: [goalkeeper, ...starters],
        substitutions: [],
        formation: this.detectFormation(starters),
        totalPoints: this.calculateTotalPoints([goalkeeper, ...starters]),
        isValid: true,
      };
    }

    let bestSolution: FormationSolution | null = null;

    // Try each valid formation
    for (const formation of VALID_FORMATIONS) {
      const solution = this.tryFormation(
        goalkeeper,
        starters,
        bench,
        nonPlayingStarters,
        formation
      );

      if (solution.isValid && (!bestSolution || solution.totalPoints > bestSolution.totalPoints)) {
        bestSolution = solution;
      }
    }

    if (!bestSolution) {
      // Fallback: return original lineup if no valid substitution found
      return {
        finalLineup: [goalkeeper, ...starters],
        substitutions: [],
        formation: this.detectFormation(starters),
        totalPoints: this.calculateTotalPoints([goalkeeper, ...starters]),
        isValid: false,
      };
    }

    return bestSolution;
  }

  private static tryFormation(
    goalkeeper: Player,
    starters: Player[],
    bench: Player[],
    nonPlayingStarters: Player[],
    targetFormation: { def: number; mid: number; fwd: number }
  ): FormationSolution {
    // Copy starters to mutate
    let lineup = [...starters];
    const substitutions: SubstitutionCandidate[] = [];
    
    // Sort bench by priority (position 0 = first sub)
    const sortedBench = [...bench].sort((a, b) => a.benchPosition - b.benchPosition);

    // For each non-playing starter
    for (const nonPlayer of nonPlayingStarters) {
      // Try each bench player in priority order
      for (const benchPlayer of sortedBench) {
        if (substitutions.some(s => s.benchPlayer.id === benchPlayer.id)) {
          continue; // Already used
        }

        // Check position compatibility (GKP can only replace GKP)
        if (nonPlayer.position === 'GKP' && benchPlayer.position !== 'GKP') {
          continue;
        }
        if (nonPlayer.position !== 'GKP' && benchPlayer.position === 'GKP') {
          continue;
        }

        // Try substitution
        const testLineup = lineup.map(p => p.id === nonPlayer.id ? benchPlayer : p);
        
        // Check if formation is valid
        if (this.matchesFormation(testLineup, targetFormation)) {
          lineup = testLineup;
          substitutions.push({
            starter: nonPlayer,
            benchPlayer,
            pointsGained: benchPlayer.gameweekPoints - nonPlayer.gameweekPoints,
          });
          break; // Move to next non-player
        }
      }
    }

    const finalLineup = [goalkeeper, ...lineup];
    const formation = this.detectFormation(lineup);
    
    return {
      finalLineup,
      substitutions,
      formation,
      totalPoints: this.calculateTotalPoints(finalLineup),
      isValid: this.isValidFormation(formation),
    };
  }

  private static matchesFormation(
    lineup: Player[],
    target: { def: number; mid: number; fwd: number }
  ): boolean {
    const counts = this.countPositions(lineup);
    return counts.def === target.def && counts.mid === target.mid && counts.fwd === target.fwd;
  }

  private static countPositions(lineup: Player[]): { def: number; mid: number; fwd: number } {
    return {
      def: lineup.filter(p => p.position === 'DEF').length,
      mid: lineup.filter(p => p.position === 'MID').length,
      fwd: lineup.filter(p => p.position === 'FWD').length,
    };
  }

  private static detectFormation(lineup: Player[]): { def: number; mid: number; fwd: number } {
    return this.countPositions(lineup);
  }

  private static isValidFormation(formation: { def: number; mid: number; fwd: number }): boolean {
    return VALID_FORMATIONS.some(
      valid => valid.def === formation.def && valid.mid === formation.mid && valid.fwd === formation.fwd
    );
  }

  private static calculateTotalPoints(lineup: Player[]): number {
    return lineup.reduce((sum, player) => sum + (player.gameweekPoints || 0), 0);
  }
}
```

### Integration with Scoring Service

```typescript
// backend/src/services/scoring/scoringService.ts
import { FormationSolver } from './formationSolver';

export class AutoSubstitutionEngine {
  async applyAutoSubstitutions(team: Team, gameweek: number): Promise<SubstitutionResult> {
    const goalkeeper = team.players.find(p => p.position === 'GKP' && p.isStarter);
    const starters = team.players.filter(p => p.isStarter && p.position !== 'GKP');
    const bench = team.players.filter(p => !p.isStarter).sort((a, b) => a.benchPosition - b.benchPosition);
    
    // Identify non-playing starters
    const nonPlayingStarters = starters.filter(p => p.minutesPlayed === 0);
    
    if (!goalkeeper || nonPlayingStarters.length === 0) {
      return { substitutions: [], finalPoints: this.calculatePoints(team) };
    }

    // Use formation solver
    const solution = FormationSolver.solve(goalkeeper, starters, bench, nonPlayingStarters);
    
    // Apply substitutions
    for (const sub of solution.substitutions) {
      await this.recordSubstitution(team.id, gameweek, sub.starter.id, sub.benchPlayer.id);
    }

    return {
      substitutions: solution.substitutions,
      formation: solution.formation,
      finalPoints: solution.totalPoints,
      isValid: solution.isValid,
    };
  }
}
```

### Test Cases

```typescript
// backend/src/tests/gameweekEdgeCases.test.ts
describe('FormationSolver', () => {
  it('handles multiple non-playing defenders without dropping below 3 DEF', () => {
    const team = createMockTeam({
      starters: [
        { position: 'GKP', minutesPlayed: 90, points: 2 },
        { position: 'DEF', minutesPlayed: 0, points: 0 }, // Non-player
        { position: 'DEF', minutesPlayed: 0, points: 0 }, // Non-player
        { position: 'DEF', minutesPlayed: 90, points: 6 },
        { position: 'DEF', minutesPlayed: 90, points: 6 },
        { position: 'MID', minutesPlayed: 90, points: 8 },
        { position: 'MID', minutesPlayed: 90, points: 8 },
        { position: 'MID', minutesPlayed: 90, points: 8 },
        { position: 'MID', minutesPlayed: 90, points: 8 },
        { position: 'FWD', minutesPlayed: 90, points: 10 },
        { position: 'FWD', minutesPlayed: 90, points: 10 },
      ],
      bench: [
        { position: 'DEF', minutesPlayed: 90, points: 4 }, // First sub
        { position: 'MID', minutesPlayed: 90, points: 6 }, // Second sub
        { position: 'FWD', minutesPlayed: 0, points: 0 },  // Third sub
        { position: 'GKP', minutesPlayed: 90, points: 2 }, // Fourth sub
      ],
    });

    const solution = FormationSolver.solve(
      team.goalkeeper,
      team.starters,
      team.bench,
      team.nonPlayingStarters
    );

    expect(solution.isValid).toBe(true);
    expect(solution.formation.def).toBeGreaterThanOrEqual(3);
    expect(solution.substitutions).toHaveLength(2);
    expect(solution.totalPoints).toBeGreaterThan(0);
  });

  it('respects bench priority order', () => {
    const team = createMockTeam({
      starters: [
        { position: 'DEF', minutesPlayed: 0, points: 0 },
      ],
      bench: [
        { position: 'MID', benchPosition: 0, points: 10 }, // First priority
        { position: 'DEF', benchPosition: 1, points: 12 }, // Higher points but lower priority
      ],
    });

    const solution = FormationSolver.solve(...);
    
    // Should try first priority first, even if second sub has higher points
    const firstSub = solution.substitutions[0];
    expect(firstSub.benchPlayer.benchPosition).toBe(0);
  });

  it('never replaces GKP with outfield player', () => {
    const team = createMockTeam({
      starters: [
        { position: 'GKP', minutesPlayed: 0, points: 0 },
      ],
      bench: [
        { position: 'DEF', benchPosition: 0, points: 6 },
        { position: 'GKP', benchPosition: 3, points: 2 },
      ],
    });

    const solution = FormationSolver.solve(...);
    
    expect(solution.substitutions[0].benchPlayer.position).toBe('GKP');
  });
});
```

---

## Issue #227: Session Revocation with Redis Token Blacklisting

**Problem:** JWT tokens remain valid until expiration. Compromised accounts cannot revoke existing sessions immediately.

### Redis Session Architecture

```typescript
// backend/src/services/auth/sessionManager.ts
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

export interface SessionMetadata {
  jti: string; // JWT ID (unique token identifier)
  userId: string;
  deviceName: string;
  ipAddress: string;
  userAgent: string;
  issuedAt: number;
  expiresAt: number;
}

export class SessionManager {
  constructor(private redis: Redis) {}

  /**
   * Store active session metadata
   * Key pattern: user:sessions:{userId}
   * Value: Hash of session metadata indexed by jti
   */
  async createSession(metadata: SessionMetadata): Promise<void> {
    const key = `user:sessions:${metadata.userId}`;
    const ttl = metadata.expiresAt - Date.now();

    await this.redis.hset(key, metadata.jti, JSON.stringify(metadata));
    await this.redis.expire(key, Math.floor(ttl / 1000));
  }

  /**
   * Get all active sessions for a user
   */
  async getActiveSessions(userId: string): Promise<SessionMetadata[]> {
    const key = `user:sessions:${userId}`;
    const sessions = await this.redis.hgetall(key);

    return Object.values(sessions).map(s => JSON.parse(s));
  }

  /**
   * Blacklist a single token
   * Key pattern: token:blacklist:{jti}
   * TTL: Match token expiration to auto-cleanup
   */
  async blacklistToken(jti: string, expiresAt: number): Promise<void> {
    const key = `token:blacklist:${jti}`;
    const ttl = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));

    await this.redis.setex(key, ttl, '1');
  }

  /**
   * Check if token is blacklisted
   * Returns: true if blacklisted
   */
  async isTokenBlacklisted(jti: string): Promise<boolean> {
    const key = `token:blacklist:${jti}`;
    const exists = await this.redis.exists(key);
    return exists === 1;
  }

  /**
   * Revoke all sessions for a user
   * Use cases: "Log out all devices", password change, account compromise
   */
  async revokeAllSessions(userId: string): Promise<number> {
    const sessions = await this.getActiveSessions(userId);
    
    // Blacklist all tokens in parallel
    const pipeline = this.redis.pipeline();
    
    for (const session of sessions) {
      const ttl = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
      pipeline.setex(`token:blacklist:${session.jti}`, ttl, '1');
    }

    // Clear session hash
    pipeline.del(`user:sessions:${userId}`);
    
    await pipeline.exec();
    return sessions.length;
  }

  /**
   * Revoke a specific session
   */
  async revokeSession(userId: string, jti: string): Promise<void> {
    const key = `user:sessions:${userId}`;
    const sessionData = await this.redis.hget(key, jti);

    if (sessionData) {
      const session: SessionMetadata = JSON.parse(sessionData);
      await this.blacklistToken(jti, session.expiresAt);
      await this.redis.hdel(key, jti);
    }
  }
}
```

### JWT Integration

```typescript
// backend/src/config/jwt.ts
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

export interface JWTPayload {
  userId: string;
  email: string;
  jti: string; // Required for revocation
  iat: number;
  exp: number;
}

export function generateAccessToken(
  userId: string,
  email: string,
  deviceName: string,
  ipAddress: string,
  userAgent: string
): { token: string; metadata: SessionMetadata } {
  const jti = uuidv4();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600; // 1 hour

  const payload: JWTPayload = {
    userId,
    email,
    jti,
    iat,
    exp,
  };

  const token = jwt.sign(payload, process.env.JWT_SECRET!);

  const metadata: SessionMetadata = {
    jti,
    userId,
    deviceName,
    ipAddress,
    userAgent,
    issuedAt: iat * 1000,
    expiresAt: exp * 1000,
  };

  return { token, metadata };
}
```

### Auth Middleware Update

```typescript
// backend/src/middleware/authMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { SessionManager } from '../services/auth/sessionManager';
import { redis } from '../config/redis';

const sessionManager = new SessionManager(redis);

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;

    // Check blacklist (< 2ms with Redis pipelining)
    const isBlacklisted = await sessionManager.isTokenBlacklisted(decoded.jti);
    if (isBlacklisted) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }

    req.user = { userId: decoded.userId, email: decoded.email, jti: decoded.jti };
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}
```

### API Endpoints

```typescript
// backend/src/routes/authRoutes.ts
import { Router } from 'express';
import { SessionManager } from '../services/auth/sessionManager';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();
const sessionManager = new SessionManager(redis);

/**
 * POST /api/v1/auth/logout
 * Revoke current session only
 */
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    const { userId, jti } = req.user;
    await sessionManager.revokeSession(userId, jti);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

/**
 * POST /api/v1/auth/logout-all
 * Revoke all sessions (all devices)
 */
router.post('/logout-all', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.user;
    const revokedCount = await sessionManager.revokeAllSessions(userId);
    res.json({ message: `Logged out from ${revokedCount} devices` });
  } catch (error) {
    res.status(500).json({ error: 'Logout all failed' });
  }
});

/**
 * GET /api/v1/auth/sessions
 * List active sessions
 */
router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.user;
    const sessions = await sessionManager.getActiveSessions(userId);
    
    const formatted = sessions.map(s => ({
      jti: s.jti,
      deviceName: s.deviceName,
      ipAddress: s.ipAddress,
      lastActive: new Date(s.issuedAt).toISOString(),
      expiresAt: new Date(s.expiresAt).toISOString(),
    }));

    res.json({ sessions: formatted });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

/**
 * DELETE /api/v1/auth/sessions/:jti
 * Revoke specific session
 */
router.delete('/sessions/:jti', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.user;
    const { jti } = req.params;
    await sessionManager.revokeSession(userId, jti);
    res.json({ message: 'Session revoked' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

export default router;
```

### Password Change Hook

```typescript
// backend/src/services/user/userService.ts
export class UserService {
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    // Verify old password
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !await bcrypt.compare(oldPassword, user.passwordHash)) {
      throw new Error('Invalid old password');
    }

    // Hash new password
    const newHash = await bcrypt.hash(newPassword, 12);

    // Update password + revoke all sessions atomically
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: newHash },
      });

      // Invalidate all existing tokens
      const sessionManager = new SessionManager(redis);
      await sessionManager.revokeAllSessions(userId);
    });
  }
}
```

---

## Issue #228: Multi-Tier League Promotion/Relegation

**Problem:** End-of-season transition logic for moving managers between league tiers is missing.

### Database Schema Reference

```prisma
model LeagueTierGroup {
  id          String        @id @default(cuid())
  leagueId    String
  league      League        @relation(fields: [leagueId], references: [id])
  season      Int
  tiers       LeagueTier[]
  createdAt   DateTime      @default(now())
}

model LeagueTier {
  id              String            @id @default(cuid())
  tierGroupId     String
  tierGroup       LeagueTierGroup   @relation(fields: [tierGroupId], references: [id])
  tierLevel       Int               // 1 = Premier, 2 = Championship, 3 = League One
  promotionSlots  Int               @default(3) // Top N move up
  relegationSlots Int               @default(3) // Bottom N move down
  members         LeagueMember[]
  createdAt       DateTime          @default(now())
}
```

### Tier Transition Pipeline

```typescript
// backend/src/services/league/leagueService.ts
import { PrismaClient, Prisma } from '@prisma/client';

export interface TierTransitionResult {
  promoted: Array<{ userId: string; fromTier: number; toTier: number }>;
  relegated: Array<{ userId: string; fromTier: number; toTier: number }>;
  unchanged: Array<{ userId: string; tier: number }>;
}

export class LeagueService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Apply end-of-season tier transitions
   * 
   * Algorithm:
   * 1. Load final standings for each tier
   * 2. Identify promotion/relegation cutoffs
   * 3. Handle tie-breaking (total goals, then transfer hits)
   * 4. Atomically move members to new tiers
   * 5. Emit domain events
   */
  async applySeasonEndTierTransitions(
    tierGroupId: string,
    completedSeason: number
  ): Promise<TierTransitionResult> {
    return await this.prisma.$transaction(async (tx) => {
      // Load tier group with all tiers and members
      const tierGroup = await tx.leagueTierGroup.findUniqueOrThrow({
        where: { id: tierGroupId },
        include: {
          tiers: {
            include: {
              members: {
                include: {
                  user: true,
                  seasonStats: {
                    where: { season: completedSeason },
                  },
                },
              },
            },
            orderBy: { tierLevel: 'asc' },
          },
        },
      });

      const result: TierTransitionResult = {
        promoted: [],
        relegated: [],
        unchanged: [],
      };

      // Process each tier (except top and bottom)
      for (let i = 0; i < tierGroup.tiers.length; i++) {
        const currentTier = tierGroup.tiers[i];
        const higherTier = tierGroup.tiers[i - 1];
        const lowerTier = tierGroup.tiers[i + 1];

        // Calculate final standings with tie-breaking
        const standings = this.calculateFinalStandings(currentTier.members, completedSeason);

        // Determine promotion candidates (if not top tier)
        if (higherTier) {
          const promotionCutoff = currentTier.promotionSlots;
          const promoted = standings.slice(0, promotionCutoff);

          for (const member of promoted) {
            await tx.leagueMember.update({
              where: { id: member.id },
              data: { tierId: higherTier.id },
            });

            result.promoted.push({
              userId: member.userId,
              fromTier: currentTier.tierLevel,
              toTier: higherTier.tierLevel,
            });
          }
        }

        // Determine relegation candidates (if not bottom tier)
        if (lowerTier) {
          const relegationCutoff = standings.length - currentTier.relegationSlots;
          const relegated = standings.slice(relegationCutoff);

          for (const member of relegated) {
            await tx.leagueMember.update({
              where: { id: member.id },
              data: { tierId: lowerTier.id },
            });

            result.relegated.push({
              userId: member.userId,
              fromTier: currentTier.tierLevel,
              toTier: lowerTier.tierLevel,
            });
          }
        }

        // Remaining members stay in current tier
        const unchangedStart = higherTier ? currentTier.promotionSlots : 0;
        const unchangedEnd = lowerTier ? standings.length - currentTier.relegationSlots : standings.length;
        const unchanged = standings.slice(unchangedStart, unchangedEnd);

        for (const member of unchanged) {
          result.unchanged.push({
            userId: member.userId,
            tier: currentTier.tierLevel,
          });
        }
      }

      // Emit domain event
      await this.emitTierTransitionEvent(tierGroupId, completedSeason, result);

      return result;
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable, // Prevent concurrent transitions
    });
  }

  /**
   * Calculate final standings with deterministic tie-breaking
   * 
   * Tie-breaking order:
   * 1. Total points (descending)
   * 2. Total goals scored (descending)
   * 3. Total transfer hits (ascending - fewer hits = better)
   * 4. User ID (ascending - deterministic fallback)
   */
  private calculateFinalStandings(
    members: Array<LeagueMember & { seasonStats: SeasonStats[] }>,
    season: number
  ): Array<LeagueMember> {
    return members
      .map(member => ({
        ...member,
        stats: member.seasonStats[0] || { totalPoints: 0, totalGoals: 0, transferHits: 0 },
      }))
      .sort((a, b) => {
        // 1. Total points (desc)
        if (a.stats.totalPoints !== b.stats.totalPoints) {
          return b.stats.totalPoints - a.stats.totalPoints;
        }

        // 2. Total goals (desc)
        if (a.stats.totalGoals !== b.stats.totalGoals) {
          return b.stats.totalGoals - a.stats.totalGoals;
        }

        // 3. Transfer hits (asc - fewer is better)
        if (a.stats.transferHits !== b.stats.transferHits) {
          return a.stats.transferHits - b.stats.transferHits;
        }

        // 4. User ID (deterministic)
        return a.userId.localeCompare(b.userId);
      });
  }

  private async emitTierTransitionEvent(
    tierGroupId: string,
    season: number,
    result: TierTransitionResult
  ): Promise<void> {
    await this.prisma.domainEvent.create({
      data: {
        eventType: 'LEAGUE_TIER_TRANSITION_COMPLETED',
        aggregateId: tierGroupId,
        payload: {
          season,
          promotedCount: result.promoted.length,
          relegatedCount: result.relegated.length,
          transitions: result,
        },
      },
    });
  }

  /**
   * Idempotency check: prevent duplicate transitions
   */
  async hasSeasonTransitionCompleted(tierGroupId: string, season: number): Promise<boolean> {
    const event = await this.prisma.domainEvent.findFirst({
      where: {
        eventType: 'LEAGUE_TIER_TRANSITION_COMPLETED',
        aggregateId: tierGroupId,
        payload: {
          path: ['season'],
          equals: season,
        },
      },
    });

    return event !== null;
  }
}
```

### Cron Job Integration

```typescript
// backend/src/jobs/seasonTransitionJob.ts
import cron from 'node-cron';
import { LeagueService } from '../services/league/leagueService';
import { prisma } from '../config/database';

const leagueService = new LeagueService(prisma);

/**
 * Run season end transitions
 * Schedule: Every day at 2 AM UTC (adjust based on FPL schedule)
 */
export function scheduleSeasonTransitions() {
  cron.schedule('0 2 * * *', async () => {
    console.log('Checking for completed seasons...');

    // Find all tier groups with completed seasons
    const completedSeasons = await prisma.leagueSeason.findMany({
      where: {
        isComplete: true,
        transitionApplied: false,
      },
      include: {
        tierGroups: true,
      },
    });

    for (const season of completedSeasons) {
      for (const tierGroup of season.tierGroups) {
        // Check idempotency
        const alreadyProcessed = await leagueService.hasSeasonTransitionCompleted(
          tierGroup.id,
          season.seasonNumber
        );

        if (!alreadyProcessed) {
          console.log(`Applying transitions for tier group ${tierGroup.id}, season ${season.seasonNumber}`);
          
          const result = await leagueService.applySeasonEndTierTransitions(
            tierGroup.id,
            season.seasonNumber
          );

          console.log(`Promoted: ${result.promoted.length}, Relegated: ${result.relegated.length}`);

          // Mark transition as applied
          await prisma.leagueSeason.update({
            where: { id: season.id },
            data: { transitionApplied: true },
          });
        }
      }
    }
  });
}
```

---

## Issue #229: Optimistic UI Updates for League Chat

**Problem:** Chat messages only appear after server acknowledgment, causing noticeable lag on slow networks.

### Optimistic Message State Machine

```typescript
// frontend/src/types/chat.ts
export type MessageStatus = 'sending' | 'delivered' | 'failed';

export interface OptimisticMessage {
  id: string; // Temporary client UUID
  serverId?: string; // Permanent server ID after ack
  leagueId: string;
  userId: string;
  content: string;
  createdAt: Date;
  status: MessageStatus;
  retryCount: number;
}
```

### Chat Store with Optimistic Updates

```typescript
// frontend/src/stores/chatStore.ts
import create from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { socketService } from '../services/socketService';

interface ChatState {
  messages: Map<string, OptimisticMessage>;
  addOptimisticMessage: (leagueId: string, content: string) => string;
  markMessageDelivered: (tempId: string, serverId: string) => void;
  markMessageFailed: (tempId: string) => void;
  retryMessage: (tempId: string) => void;
  rollbackMessage: (tempId: string) => void;
  addReactionOptimistic: (messageId: string, emoji: string) => void;
  rollbackReaction: (messageId: string, emoji: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: new Map(),

  addOptimisticMessage: (leagueId, content) => {
    const tempId = uuidv4();
    const message: OptimisticMessage = {
      id: tempId,
      leagueId,
      userId: 'current-user-id', // Get from auth context
      content,
      createdAt: new Date(),
      status: 'sending',
      retryCount: 0,
    };

    set((state) => {
      const newMessages = new Map(state.messages);
      newMessages.set(tempId, message);
      return { messages: newMessages };
    });

    // Send to server
    socketService.sendMessage(leagueId, content, tempId);

    return tempId;
  },

  markMessageDelivered: (tempId, serverId) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      const message = newMessages.get(tempId);
      if (message) {
        message.serverId = serverId;
        message.status = 'delivered';
        newMessages.set(tempId, message);
      }
      return { messages: newMessages };
    });
  },

  markMessageFailed: (tempId) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      const message = newMessages.get(tempId);
      if (message) {
        message.status = 'failed';
        newMessages.set(tempId, message);
      }
      return { messages: newMessages };
    });
  },

  retryMessage: (tempId) => {
    const message = get().messages.get(tempId);
    if (!message) return;

    set((state) => {
      const newMessages = new Map(state.messages);
      const msg = newMessages.get(tempId);
      if (msg) {
        msg.status = 'sending';
        msg.retryCount += 1;
        newMessages.set(tempId, msg);
      }
      return { messages: newMessages };
    });

    socketService.sendMessage(message.leagueId, message.content, tempId);
  },

  rollbackMessage: (tempId) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      newMessages.delete(tempId);
      return { messages: newMessages };
    });
  },

  addReactionOptimistic: (messageId, emoji) => {
    // Optimistically increment reaction counter
    // Implementation details omitted for brevity
  },

  rollbackReaction: (messageId, emoji) => {
    // Rollback reaction if server rejects
  },
}));
```

### React Component with Optimistic Rendering

```typescript
// frontend/src/components/league/LeagueChat.tsx
import React, { useState, useEffect } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { socketService } from '../../services/socketService';

export function LeagueChat({ leagueId }: { leagueId: string }) {
  const [inputValue, setInputValue] = useState('');
  const { messages, addOptimisticMessage, retryMessage, rollbackMessage } = useChatStore();

  useEffect(() => {
    // Setup WebSocket listeners
    socketService.on('message:ack', ({ tempId, serverId }) => {
      useChatStore.getState().markMessageDelivered(tempId, serverId);
    });

    socketService.on('message:error', ({ tempId, error }) => {
      useChatStore.getState().markMessageFailed(tempId);
    });

    return () => {
      socketService.off('message:ack');
      socketService.off('message:error');
    };
  }, []);

  const handleSend = () => {
    if (!inputValue.trim()) return;

    addOptimisticMessage(leagueId, inputValue);
    setInputValue('');
  };

  const sortedMessages = Array.from(messages.values())
    .filter(m => m.leagueId === leagueId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return (
    <div className="league-chat">
      <div className="messages">
        {sortedMessages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            onRetry={() => retryMessage(message.id)}
            onRollback={() => rollbackMessage(message.id)}
          />
        ))}
      </div>
      
      <div className="input-area">
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Type a message..."
        />
        <button onClick={handleSend}>Send</button>
      </div>
    </div>
  );
}

function ChatMessage({
  message,
  onRetry,
  onRollback,
}: {
  message: OptimisticMessage;
  onRetry: () => void;
  onRollback: () => void;
}) {
  return (
    <div className={`message message--${message.status}`}>
      <div className="message__content">{message.content}</div>
      
      {message.status === 'sending' && (
        <div className="message__status">
          <span className="spinner" /> Sending...
        </div>
      )}
      
      {message.status === 'failed' && (
        <div className="message__error">
          <span className="error-icon">⚠️</span>
          Failed to send
          <button onClick={onRetry}>Retry</button>
          <button onClick={onRollback}>Delete</button>
        </div>
      )}
    </div>
  );
}
```

### WebSocket Service

```typescript
// frontend/src/services/socketService.ts
import io, { Socket } from 'socket.io-client';

class SocketService {
  private socket: Socket | null = null;

  connect(token: string) {
    this.socket = io(process.env.REACT_APP_WS_URL!, {
      auth: { token },
      transports: ['websocket'],
    });

    this.socket.on('connect', () => {
      console.log('WebSocket connected');
    });

    this.socket.on('disconnect', () => {
      console.log('WebSocket disconnected');
    });
  }

  sendMessage(leagueId: string, content: string, tempId: string) {
    if (!this.socket) return;

    this.socket.emit('message:send', { leagueId, content, tempId }, (response) => {
      if (response.success) {
        this.socket!.emit('message:ack', { tempId, serverId: response.messageId });
      } else {
        this.socket!.emit('message:error', { tempId, error: response.error });
      }
    });
  }

  on(event: string, handler: (data: any) => void) {
    this.socket?.on(event, handler);
  }

  off(event: string) {
    this.socket?.off(event);
  }
}

export const socketService = new SocketService();
```

---

## Testing Checklist

### Formation Solver (#226)
- [ ] Handles multiple non-playing defenders without dropping below 3 DEF
- [ ] Respects bench priority order (position 0 = first sub)
- [ ] Never replaces GKP with outfield player
- [ ] Finds globally optimal formation (not just first valid)
- [ ] Passes all historical FPL edge cases

### Session Management (#227)
- [ ] Blacklist check adds < 2ms latency
- [ ] Logout revokes current token immediately
- [ ] Logout-all invalidates all user sessions
- [ ] Password change invalidates all sessions
- [ ] Expired blacklist entries auto-cleanup via Redis TTL

### Tier Transitions (#228)
- [ ] Promoted managers move up one tier
- [ ] Relegated managers move down one tier
- [ ] Ties broken deterministically (points → goals → hits)
- [ ] Idempotent (running twice doesn't duplicate transitions)
- [ ] Domain events emitted with transition summary

### Optimistic UI (#229)
- [ ] Messages appear instantly with zero delay
- [ ] Delivered messages replace temp ID with server ID
- [ ] Failed messages show retry button
- [ ] Rollback removes message from UI
- [ ] Reactions increment optimistically and rollback on error

---

**Last Updated:** October 2024  
**Status:** Implementation Guide
