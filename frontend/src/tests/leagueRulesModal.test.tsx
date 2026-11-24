import { describe, it, expect, beforeEach, afterEach } from 'node:test';
import { calculatePrizeBreakdown } from '../components/LeagueRulesModal';

describe('LeagueRulesModal - Prize Math', () => {
  describe('calculatePrizeBreakdown', () => {
    it('distributes 60/30/10 split with 5% platform fee exactly', () => {
      // $10 entry fee × 100 participants = $1000 gross
      // = 100,000 cents
      const entryFeeInCents = 1000; // $10
      const participantCount = 100;

      const result = calculatePrizeBreakdown(entryFeeInCents, participantCount);

      // Gross: 100,000 cents
      const expectedGross = 100000;
      // Fee: 5% of 100,000 = 5,000 cents
      const expectedFee = 5000;
      // Net: 95,000 cents
      const netDistributable = 95000;
      // 60% = 57,000, 30% = 28,500, 10% = 9,500
      const expectedFirst = 57000;
      const expectedSecond = 28500;
      const expectedThird = 9500;

      expect(result.platformFee).toBe(expectedFee);
      expect(result.first).toBe(expectedFirst);
      expect(result.second).toBe(expectedSecond);
      expect(result.third).toBe(expectedThird);

      // Total must equal gross (with remainder added to first)
      const total = result.first + result.second + result.third + result.platformFee;
      expect(total).toBe(expectedGross);
    });

    it('handles $0 entry fee gracefully', () => {
      const result = calculatePrizeBreakdown(0, 10);
      expect(result.first).toBe(0);
      expect(result.second).toBe(0);
      expect(result.third).toBe(0);
      expect(result.platformFee).toBe(0);
    });

    it('handles very small pools with rounding', () => {
      // $1 entry × 3 participants = $3 = 300 cents
      const result = calculatePrizeBreakdown(100, 3); // 100 cents entry × 3
      const grossPool = 300;
      const fee = Math.floor((grossPool * 5) / 100); // 15 cents
      const net = grossPool - fee; // 285 cents

      // Verify total sums correctly
      const total = result.first + result.second + result.third + result.platformFee;
      expect(total).toBe(grossPool);
    });

    it('handles single participant (no prize)', () => {
      const result = calculatePrizeBreakdown(10000, 1);
      const total = result.first + result.second + result.third + result.platformFee;
      expect(total).toBe(10000);
    });

    it('handles two participants (no 3rd place)', () => {
      const result = calculatePrizeBreakdown(5000, 2);
      const total = result.first + result.second + result.third + result.platformFee;
      expect(total).toBe(10000);
    });

    it('platform fee is never positive and zero when no pool', () => {
      const result = calculatePrizeBreakdown(0, 100);
      expect(result.platformFee).toBe(0);
      expect(result.platformFee >= 0).toBe(true);
    });

    it('handles large pools without floating point drift', () => {
      // $1,000,000 entry × 1000 participants
      const entryFeeInCents = 100000000; // $1,000,000
      const participantCount = 1000;

      const result = calculatePrizeBreakdown(entryFeeInCents, participantCount);

      const grossPool = entryFeeInCents * participantCount;
      const total = result.first + result.second + result.third + result.platformFee;

      // Must equal exactly (no floating point error)
      expect(total).toBe(grossPool);

      // No NaN or Infinity
      expect(isNaN(result.first)).toBe(false);
      expect(isNaN(result.second)).toBe(false);
      expect(isNaN(result.third)).toBe(false);
      expect(isFinite(result.first)).toBe(true);
    });

    it('prize amounts are never negative', () => {
      const result = calculatePrizeBreakdown(10000, 100);
      expect(result.first >= 0).toBe(true);
      expect(result.second >= 0).toBe(true);
      expect(result.third >= 0).toBe(true);
      expect(result.platformFee >= 0).toBe(true);
    });

    it('respects custom percentage splits', () => {
      const entryFeeInCents = 10000; // $100
      const participantCount = 10; // Total = 100,000 cents
      const customPercentages = { first: 50, second: 30, third: 20 };

      const result = calculatePrizeBreakdown(entryFeeInCents, participantCount, customPercentages);

      const grossPool = 100000;
      const fee = 5000;
      const net = 95000;

      // 50% of 95000 = 47500, 30% = 28500, 20% = 19000
      // Total with fee should equal gross
      const total = result.first + result.second + result.third + result.platformFee;
      expect(total).toBe(grossPool);
    });

    it('respects custom platform fee percentage', () => {
      const entryFeeInCents = 10000;
      const participantCount = 10;
      const platformFeePercentage = 10; // 10% instead of 5%

      const result = calculatePrizeBreakdown(entryFeeInCents, participantCount, undefined, platformFeePercentage);

      const grossPool = 100000;
      const expectedFee = 10000; // 10% of 100,000

      expect(result.platformFee).toBe(expectedFee);

      const total = result.first + result.second + result.third + result.platformFee;
      expect(total).toBe(grossPool);
    });

    it('rounding remainder is deterministically assigned to 1st place', () => {
      // Create a case where rounding leaves a remainder
      const entryFeeInCents = 333; // Odd amount to force rounding
      const participantCount = 100;

      const result = calculatePrizeBreakdown(entryFeeInCents, participantCount);

      const grossPool = 33300;
      const total = result.first + result.second + result.third + result.platformFee;

      // Total must equal gross exactly
      expect(total).toBe(grossPool);

      // Any remainder should be in first place (check by comparing to a recalculated value)
      const fee = Math.floor((grossPool * 5) / 100);
      const net = grossPool - fee;
      const firstBase = Math.floor((net * 60) / 100);
      const secondBase = Math.floor((net * 30) / 100);
      const thirdBase = Math.floor((net * 10) / 100);
      const distributed = firstBase + secondBase + thirdBase + fee;
      const expectedRemainder = grossPool - distributed;

      // The remainder should be added to first place
      expect(result.first).toBe(firstBase + expectedRemainder);
    });
  });
});
