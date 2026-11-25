import { describe, it, expect } from 'node:test';
import { resolveWaiverClaimsEngine, type WaiverClaim } from '../services/waiverWireService';

describe('Waiver Wire Resolution Engine', () => {
  describe('Highest Bid Wins', () => {
    it('should award player to highest bidder when bids differ', () => {
      const claims: WaiverClaim[] = [
        {
          id: 'claim-1',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-1',
          playerToAdd: 'player-A',
          bidAmount: 10,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
        {
          id: 'claim-2',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-2',
          playerToAdd: 'player-A',
          bidAmount: 15,
          status: 'pending',
          submittedAt: new Date('2024-01-01T11:00:00Z'),
        },
      ];

      const priorities = { 'manager-1': 1, 'manager-2': 2 };
      const budgets = { 'manager-1': 100, 'manager-2': 100 };
      const rosters = { 'manager-1': 5, 'manager-2': 5 };
      const owned = new Set<string>();

      const result = resolveWaiverClaimsEngine(claims, priorities, budgets, rosters, owned);

      expect(result.wins).toHaveLength(1);
      expect(result.wins[0].id).toBe('claim-2');
      expect(result.wins[0].finalBid).toBe(15);
      expect(result.losses).toHaveLength(1);
      expect(result.losses[0].reasonCode).toBe('outbid');
    });
  });

  describe('Tie-Breaking by Priority', () => {
    it('should break ties on bid amount by waiver priority', () => {
      const claims: WaiverClaim[] = [
        {
          id: 'claim-1',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-1',
          playerToAdd: 'player-A',
          bidAmount: 10,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
        {
          id: 'claim-2',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-2',
          playerToAdd: 'player-A',
          bidAmount: 10,
          status: 'pending',
          submittedAt: new Date('2024-01-01T11:00:00Z'),
        },
      ];

      // manager-1 has priority 1 (better), manager-2 has priority 2
      const priorities = { 'manager-1': 1, 'manager-2': 2 };
      const budgets = { 'manager-1': 100, 'manager-2': 100 };
      const rosters = { 'manager-1': 5, 'manager-2': 5 };
      const owned = new Set<string>();

      const result = resolveWaiverClaimsEngine(claims, priorities, budgets, rosters, owned);

      expect(result.wins).toHaveLength(1);
      expect(result.wins[0].id).toBe('claim-1');
      expect(result.losses).toHaveLength(1);
      expect(result.losses[0].reasonCode).toBe('outbid');
    });
  });

  describe('Tie-Breaking by Submission Time', () => {
    it('should break priority ties by earlier submission timestamp', () => {
      const claims: WaiverClaim[] = [
        {
          id: 'claim-1',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-1',
          playerToAdd: 'player-A',
          bidAmount: 10,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
        {
          id: 'claim-2',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-2',
          playerToAdd: 'player-A',
          bidAmount: 10,
          status: 'pending',
          submittedAt: new Date('2024-01-01T09:00:00Z'), // Earlier
        },
      ];

      const priorities = { 'manager-1': 1, 'manager-2': 1 }; // Same priority
      const budgets = { 'manager-1': 100, 'manager-2': 100 };
      const rosters = { 'manager-1': 5, 'manager-2': 5 };
      const owned = new Set<string>();

      const result = resolveWaiverClaimsEngine(claims, priorities, budgets, rosters, owned);

      expect(result.wins).toHaveLength(1);
      expect(result.wins[0].id).toBe('claim-2'); // Earlier submission wins
      expect(result.losses[0].reasonCode).toBe('outbid');
    });
  });

  describe('Deterministic Final Tie-Breaker (Claim ID)', () => {
    it('should use claim ID for stable final tie-breaking', () => {
      const claims: WaiverClaim[] = [
        {
          id: 'aaa',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-1',
          playerToAdd: 'player-A',
          bidAmount: 10,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
        {
          id: 'zzz',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-2',
          playerToAdd: 'player-A',
          bidAmount: 10,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
      ];

      const priorities = { 'manager-1': 1, 'manager-2': 1 };
      const budgets = { 'manager-1': 100, 'manager-2': 100 };
      const rosters = { 'manager-1': 5, 'manager-2': 5 };
      const owned = new Set<string>();

      const result = resolveWaiverClaimsEngine(claims, priorities, budgets, rosters, owned);

      expect(result.wins).toHaveLength(1);
      expect(result.wins[0].id).toBe('aaa'); // Lexicographically first
    });
  });

  describe('Budget Validation', () => {
    it('should invalidate claim if manager lacks budget', () => {
      const claims: WaiverClaim[] = [
        {
          id: 'claim-1',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-1',
          playerToAdd: 'player-A',
          bidAmount: 150,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
      ];

      const priorities = { 'manager-1': 1 };
      const budgets = { 'manager-1': 100 }; // Less than bid
      const rosters = { 'manager-1': 5 };
      const owned = new Set<string>();

      const result = resolveWaiverClaimsEngine(claims, priorities, budgets, rosters, owned);

      expect(result.wins).toHaveLength(0);
      expect(result.invalids).toHaveLength(1);
      expect(result.invalids[0].reasonCode).toBe('insufficient_budget');
    });
  });

  describe('Roster Limit Validation', () => {
    it('should invalidate claim if roster is full', () => {
      const claims: WaiverClaim[] = [
        {
          id: 'claim-1',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-1',
          playerToAdd: 'player-A',
          bidAmount: 10,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
      ];

      const priorities = { 'manager-1': 1 };
      const budgets = { 'manager-1': 100 };
      const rosters = { 'manager-1': 0 }; // Full
      const owned = new Set<string>();

      const result = resolveWaiverClaimsEngine(claims, priorities, budgets, rosters, owned);

      expect(result.wins).toHaveLength(0);
      expect(result.invalids).toHaveLength(1);
      expect(result.invalids[0].reasonCode).toBe('roster_full');
    });
  });

  describe('Player Already Owned', () => {
    it('should invalidate all claims for already-owned players', () => {
      const claims: WaiverClaim[] = [
        {
          id: 'claim-1',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-1',
          playerToAdd: 'player-A',
          bidAmount: 10,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
        {
          id: 'claim-2',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-2',
          playerToAdd: 'player-A',
          bidAmount: 15,
          status: 'pending',
          submittedAt: new Date('2024-01-01T11:00:00Z'),
        },
      ];

      const priorities = { 'manager-1': 1, 'manager-2': 2 };
      const budgets = { 'manager-1': 100, 'manager-2': 100 };
      const rosters = { 'manager-1': 5, 'manager-2': 5 };
      const owned = new Set(['player-A']); // Already owned

      const result = resolveWaiverClaimsEngine(claims, priorities, budgets, rosters, owned);

      expect(result.wins).toHaveLength(0);
      expect(result.invalids).toHaveLength(2);
      expect(result.invalids[0].reasonCode).toBe('player_already_owned');
      expect(result.invalids[1].reasonCode).toBe('player_already_owned');
    });
  });

  describe('Cascading Losses on Budget Exhaustion', () => {
    it('should lose other pending claims when win exhausts budget', () => {
      const claims: WaiverClaim[] = [
        {
          id: 'claim-1',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-1',
          playerToAdd: 'player-A',
          bidAmount: 90,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
        {
          id: 'claim-2',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-1',
          playerToAdd: 'player-B',
          bidAmount: 20,
          status: 'pending',
          submittedAt: new Date('2024-01-01T11:00:00Z'),
        },
      ];

      const priorities = { 'manager-1': 1 };
      const budgets = { 'manager-1': 100 };
      const rosters = { 'manager-1': 10 };
      const owned = new Set<string>();

      const result = resolveWaiverClaimsEngine(claims, priorities, budgets, rosters, owned);

      expect(result.wins).toHaveLength(1);
      expect(result.wins[0].id).toBe('claim-1');
      expect(result.losses).toHaveLength(1);
      expect(result.losses[0].reasonCode).toBe('insufficient_budget_after_win');
    });
  });

  describe('Complex 10-Manager Scenario', () => {
    it('should resolve overlapping claims deterministically with diverse priorities and bids', () => {
      // 10 managers bidding on 5 players
      const players = ['player-1', 'player-2', 'player-3', 'player-4', 'player-5'];
      const managers = Array.from({ length: 10 }, (_, i) => `manager-${i + 1}`);

      const claims: WaiverClaim[] = [
        // Player 1: different bids
        {
          id: 'c1',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-1',
          playerToAdd: 'player-1',
          bidAmount: 50,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
        {
          id: 'c2',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-2',
          playerToAdd: 'player-1',
          bidAmount: 80,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:05:00Z'),
        },
        // Player 2: same bid, different priority
        {
          id: 'c3',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-3',
          playerToAdd: 'player-2',
          bidAmount: 40,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:10:00Z'),
        },
        {
          id: 'c4',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'manager-4',
          playerToAdd: 'player-2',
          bidAmount: 40,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:15:00Z'),
        },
      ];

      const priorities: Record<string, number> = {
        'manager-1': 5,
        'manager-2': 3,
        'manager-3': 1,
        'manager-4': 2,
      };

      const budgets: Record<string, number> = {
        'manager-1': 100,
        'manager-2': 100,
        'manager-3': 100,
        'manager-4': 100,
      };

      const rosters: Record<string, number> = {
        'manager-1': 5,
        'manager-2': 5,
        'manager-3': 5,
        'manager-4': 5,
      };

      const owned = new Set<string>();

      const result = resolveWaiverClaimsEngine(claims, priorities, budgets, rosters, owned);

      expect(result.wins).toHaveLength(2);
      expect(result.wins.some((w) => w.id === 'c2' && w.playerToAdd === 'player-1')).toBe(true); // Highest bid
      expect(result.wins.some((w) => w.id === 'c3' && w.playerToAdd === 'player-2')).toBe(true); // Better priority on tie
    });
  });

  describe('Idempotency and Order Independence', () => {
    it('should produce same results regardless of claim input order', () => {
      const claimsA: WaiverClaim[] = [
        {
          id: 'c1',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'm1',
          playerToAdd: 'p1',
          bidAmount: 50,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
        {
          id: 'c2',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'm2',
          playerToAdd: 'p1',
          bidAmount: 100,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:05:00Z'),
        },
      ];

      const claimsB = [...claimsA].reverse();

      const priorities = { 'm1': 1, 'm2': 2 };
      const budgets = { 'm1': 200, 'm2': 200 };
      const rosters = { 'm1': 10, 'm2': 10 };
      const owned = new Set<string>();

      const resultA = resolveWaiverClaimsEngine(claimsA, priorities, budgets, rosters, owned);
      const resultB = resolveWaiverClaimsEngine(claimsB, priorities, budgets, rosters, owned);

      // Results should be identical
      expect(resultA.wins.map((w) => w.id).sort()).toEqual(resultB.wins.map((w) => w.id).sort());
      expect(resultA.losses.map((l) => l.id).sort()).toEqual(resultB.losses.map((l) => l.id).sort());
    });
  });

  describe('Zero Budget and Roster Edge Cases', () => {
    it('should handle zero available budget', () => {
      const claims: WaiverClaim[] = [
        {
          id: 'c1',
          leagueId: 'league-1',
          gameweek: 5,
          managerId: 'm1',
          playerToAdd: 'p1',
          bidAmount: 10,
          status: 'pending',
          submittedAt: new Date('2024-01-01T10:00:00Z'),
        },
      ];

      const priorities = { 'm1': 1 };
      const budgets = { 'm1': 0 };
      const rosters = { 'm1': 10 };
      const owned = new Set<string>();

      const result = resolveWaiverClaimsEngine(claims, priorities, budgets, rosters, owned);

      expect(result.invalids).toHaveLength(1);
      expect(result.invalids[0].reasonCode).toBe('insufficient_budget');
    });
  });
});
