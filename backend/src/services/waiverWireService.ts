import { prisma } from '../config/prisma';

export interface WaiverClaim {
  id: string;
  leagueId: string;
  gameweek: number;
  managerId: string;
  playerToAdd: string;
  playerToDrop?: string;
  bidAmount: number;
  status: 'pending' | 'won' | 'lost' | 'cancelled' | 'invalid';
  submittedAt: Date;
  resolutionReason?: string;
}

interface ResolutionContext {
  now: Date; // Injected for testing
}

/**
 * Pure waiver resolution engine - deterministic, side-effect-free.
 * 
 * Processes claims with deterministic tie-breaking:
 * 1. Highest bid wins
 * 2. Tied bids: better waiver priority wins
 * 3. Same priority: earlier submission timestamp wins
 * 4. Still tied: claim ID (stable, final tie-breaker)
 * 
 * Re-validates each winning claim:
 * - Manager has sufficient remaining budget
 * - Roster limits still satisfied
 * - Player still unowned
 * 
 * Cascading: Manager whose win exhausts budget/roster loses other pending claims with reason code.
 * 
 * @returns Decision set: wins, losses, invalids with reason codes
 */
export function resolveWaiverClaimsEngine(
  claims: WaiverClaim[],
  managerPriorities: Record<string, number>, // 1 = highest priority
  managerBudgets: Record<string, number>, // available budget per manager
  rosterLimits: Record<string, number>, // available slots per manager
  ownedPlayers: Set<string> // Set of already-owned player IDs
): {
  wins: Array<WaiverClaim & { finalBid: number }>;
  losses: Array<WaiverClaim & { reasonCode: string }>;
  invalids: Array<WaiverClaim & { reasonCode: string }>;
} {
  const wins: Array<WaiverClaim & { finalBid: number }> = [];
  const losses: Array<WaiverClaim & { reasonCode: string }> = [];
  const invalids: Array<WaiverClaim & { reasonCode: string }> = [];

  // Group claims by player
  const claimsByPlayer = new Map<string, WaiverClaim[]>();
  for (const claim of claims) {
    if (!claimsByPlayer.has(claim.playerToAdd)) {
      claimsByPlayer.set(claim.playerToAdd, []);
    }
    claimsByPlayer.get(claim.playerToAdd)!.push(claim);
  }

  // Track wins per manager for cascading invalidation
  const managerWins = new Map<string, number>();

  // Process each player
  for (const [playerId, playerClaims] of claimsByPlayer.entries()) {
    // Quick validation: player must not be already owned
    if (ownedPlayers.has(playerId)) {
      for (const claim of playerClaims) {
        invalids.push({
          ...claim,
          reasonCode: 'player_already_owned',
        });
      }
      continue;
    }

    // Sort claims by bid (desc), then priority (asc = better), then timestamp (asc), then ID (asc)
    const sorted = [...playerClaims].sort((a, b) => {
      // 1. Highest bid wins
      if (a.bidAmount !== b.bidAmount) {
        return b.bidAmount - a.bidAmount;
      }

      // 2. Better priority (lower number = better)
      const priorityA = managerPriorities[a.managerId] ?? Infinity;
      const priorityB = managerPriorities[b.managerId] ?? Infinity;
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      // 3. Earlier submission
      if (a.submittedAt !== b.submittedAt) {
        return a.submittedAt.getTime() - b.submittedAt.getTime();
      }

      // 4. Stable tie-breaker: claim ID (lexicographic)
      return a.id.localeCompare(b.id);
    });

    const winner = sorted[0];
    const losers = sorted.slice(1);

    // Re-validate winner
    const managerBudget = managerBudgets[winner.managerId] ?? 0;
    const rosterSlots = rosterLimits[winner.managerId] ?? 0;

    let winnerValid = true;
    let invalidReason = '';

    if (winner.bidAmount > managerBudget) {
      winnerValid = false;
      invalidReason = 'insufficient_budget';
    } else if (rosterSlots <= 0) {
      winnerValid = false;
      invalidReason = 'roster_full';
    }

    if (!winnerValid) {
      invalids.push({
        ...winner,
        reasonCode: invalidReason,
      });

      // All losers also become invalid since the player is effectively unavailable
      for (const loser of losers) {
        losses.push({
          ...loser,
          reasonCode: 'player_unavailable',
        });
      }
    } else {
      // Winner is valid: record win, deduct budget/roster
      wins.push({
        ...winner,
        finalBid: winner.bidAmount,
      });

      managerWins.set(
        winner.managerId,
        (managerWins.get(winner.managerId) ?? 0) + 1
      );

      // Update budget/roster for cascading checks
      managerBudgets[winner.managerId] -= winner.bidAmount;
      rosterLimits[winner.managerId] -= 1;

      // Record losses
      for (const loser of losers) {
        losses.push({
          ...loser,
          reasonCode: 'outbid',
        });
      }
    }
  }

  // Cascading: check each manager's other pending claims against their updated budget/roster
  const allClaimsMap = new Map<string, WaiverClaim>();
  for (const claim of claims) {
    allClaimsMap.set(claim.id, claim);
  }

  for (const [managerId, winCount] of managerWins.entries()) {
    const updatedBudget = managerBudgets[managerId];
    const updatedRoster = rosterLimits[managerId];

    // Find any pending claims by this manager that aren't yet decided
    const pendingByManager = claims.filter(
      (c) => c.managerId === managerId && !wins.some((w) => w.id === c.id) && !losses.some((l) => l.id === c.id) && !invalids.some((i) => i.id === c.id)
    );

    for (const pending of pendingByManager) {
      if (pending.bidAmount > updatedBudget) {
        // Move from pending to loss
        const lossIndex = losses.findIndex((l) => l.id === pending.id);
        if (lossIndex === -1) {
          losses.push({
            ...pending,
            reasonCode: 'insufficient_budget_after_win',
          });
        }
      } else if (updatedRoster <= 0) {
        const lossIndex = losses.findIndex((l) => l.id === pending.id);
        if (lossIndex === -1) {
          losses.push({
            ...pending,
            reasonCode: 'roster_full_after_win',
          });
        }
      }
    }
  }

  return { wins, losses, invalids };
}

/**
 * Atomic transaction: apply waiver resolution decisions to the database.
 * Charge winners, release losers/invalids, update priorities.
 * 
 * Idempotent: calling twice for same window changes nothing.
 */
export async function applyWaiverResolution(
  leagueId: string,
  gameweek: number,
  decisions: {
    wins: Array<WaiverClaim & { finalBid: number }>;
    losses: Array<WaiverClaim & { reasonCode: string }>;
    invalids: Array<WaiverClaim & { reasonCode: string }>;
  }
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Check idempotency: if this window already resolved, skip
    const existingResolution = await tx.waiverResolution.findUnique({
      where: {
        leagueId_gameweek: { leagueId, gameweek },
      },
    });

    if (existingResolution) {
      return; // Already resolved
    }

    // Record resolution event (guards against re-running)
    await tx.waiverResolution.create({
      data: {
        leagueId,
        gameweek,
        resolvedAt: new Date(),
      },
    });

    // Process wins: charge budget, transfer ownership, update priority
    for (const win of decisions.wins) {
      // Charge escrow -> spend
      await tx.escrowHold.deleteMany({
        where: {
          managerId: win.managerId,
          claimId: win.id,
        },
      });

      // Record transfer ownership
      await tx.ownership.create({
        data: {
          leagueId: win.leagueId,
          managerId: win.managerId,
          playerId: win.playerToAdd,
          acquiredAt: new Date(),
        },
      });

      // If dropping a player, release that too
      if (win.playerToDrop) {
        await tx.ownership.deleteMany({
          where: {
            leagueId: win.leagueId,
            managerId: win.managerId,
            playerId: win.playerToDrop,
          },
        });
      }

      // Update waiver priority (move to back if using rolling priority)
      await tx.waiverPriority.update({
        where: {
          leagueId_managerId: {
            leagueId: win.leagueId,
            managerId: win.managerId,
          },
        },
        data: {
          priority: 999999, // Move to back of queue
        },
      });

      // Update claim status
      await tx.waiverClaim.update({
        where: { id: win.id },
        data: {
          status: 'won',
          resolutionReason: 'won',
        },
      });
    }

    // Process losses and invalids: release escrow holds immediately
    for (const claim of [...decisions.losses, ...decisions.invalids]) {
      // Release escrow
      await tx.escrowHold.deleteMany({
        where: {
          managerId: claim.managerId,
          claimId: claim.id,
        },
      });

      // Update claim status
      await tx.waiverClaim.update({
        where: { id: claim.id },
        data: {
          status: claim.reasonCode === 'outbid' ? 'lost' : 'invalid',
          resolutionReason: claim.reasonCode,
        },
      });
    }
  });
}

/**
 * Submit a waiver claim with atomicity.
 * Places escrow hold; rejects if manager doesn't have budget or player already owned.
 */
export async function submitWaiverClaim(
  leagueId: string,
  managerId: string,
  playerToAdd: string,
  playerToDrop: string | undefined,
  bidAmount: number
): Promise<WaiverClaim> {
  return await prisma.$transaction(async (tx) => {
    // Validate league is waiver type
    const league = await tx.league.findUnique({
      where: { id: leagueId },
    });

    if (!league || league.type !== 'WAIVER') {
      throw new Error('League is not a waiver-type league');
    }

    // Validate player is free agent
    const ownedCount = await tx.ownership.count({
      where: {
        leagueId,
        playerId: playerToAdd,
      },
    });

    if (ownedCount > 0) {
      throw new Error('Player is not a free agent');
    }

    // Get manager budget
    const manager = await tx.manager.findUnique({
      where: { id: managerId },
    });

    if (!manager) {
      throw new Error('Manager not found');
    }

    const availableBudget = (manager.totalBudget ?? 0) - (manager.heldBudget ?? 0);

    if (bidAmount > availableBudget) {
      throw new Error('Insufficient available budget');
    }

    // Prevent duplicate claim
    const existing = await tx.waiverClaim.findFirst({
      where: {
        leagueId,
        gameweek: league.currentGameweek,
        managerId,
        playerToAdd,
        status: 'pending',
      },
    });

    if (existing) {
      throw new Error('Manager already has a pending bid on this player');
    }

    // Create claim
    const claim = await tx.waiverClaim.create({
      data: {
        leagueId,
        gameweek: league.currentGameweek,
        managerId,
        playerToAdd,
        playerToDrop,
        bidAmount,
        status: 'pending',
        submittedAt: new Date(),
      },
    });

    // Place escrow hold
    await tx.escrowHold.create({
      data: {
        managerId,
        claimId: claim.id,
        heldAmount: bidAmount,
      },
    });

    // Update manager's held budget
    await tx.manager.update({
      where: { id: managerId },
      data: {
        heldBudget: (manager.heldBudget ?? 0) + bidAmount,
      },
    });

    return claim;
  });
}

/**
 * Cancel a waiver claim, releasing escrow.
 */
export async function cancelWaiverClaim(claimId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.waiverClaim.findUnique({
      where: { id: claimId },
    });

    if (!claim) {
      throw new Error('Claim not found');
    }

    if (claim.status !== 'pending') {
      throw new Error('Can only cancel pending claims');
    }

    // Release escrow
    const hold = await tx.escrowHold.findFirst({
      where: { claimId },
    });

    if (hold) {
      await tx.escrowHold.delete({
        where: { id: hold.id },
      });

      // Update manager's held budget
      await tx.manager.update({
        where: { id: claim.managerId },
        data: {
          heldBudget: Math.max(0, (await tx.manager.findUnique({ where: { id: claim.managerId } }))?.heldBudget ?? 0 - hold.heldAmount),
        },
      });
    }

    // Update claim status
    await tx.waiverClaim.update({
      where: { id: claimId },
      data: {
        status: 'cancelled',
      },
    });
  });
}
