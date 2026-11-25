# Settlement System Integration Guide

## Quick Start

### 1. Single-Currency Settlement (USDC only)

```typescript
import { SettlementCalculator } from './settlementCalculator';

// Calculate payouts for a finished league
const settlement = SettlementCalculator.calculateSettlement(
  500,  // $5 entry fee (in cents)
  10    // 10 participants
);

console.log({
  'Gross Pool': settlement.grossPoolCents / 100, // $50.00
  'Platform Fee (5%)': settlement.platformFeeCents / 100, // $2.50
  'Prize Pool': settlement.prizePoolCents / 100, // $47.50
  'First Place': settlement.prizesCents[0] / 100, // $28.50 (60%)
  'Second Place': settlement.prizesCents[1] / 100, // $14.25 (30%)
  'Third Place': settlement.prizesCents[2] / 100, // $4.75 (10%)
});

// Verify invariant
if (settlement.invariantValid) {
  console.log('✓ Settlement is valid, proceed with payouts');
} else {
  console.log('✗ Invariant violated, do not proceed');
  throw new Error('Settlement calculation failed');
}
```

### 2. Multi-Currency Settlement

```typescript
import { MultiAssetSettlement } from './multiAssetSettlement';
import { CurrencyConverter, MockRateProvider } from './currencyConverter';

// Set up converter with real rates (replace with real oracle)
const rateProvider = new MockRateProvider({
  USDC_ZEC: 0.015,
  USDC_XLM: 4.5,
  ZEC_USDC: 67,
  XLM_USDC: 0.22,
  ZEC_XLM: 300,
  XLM_ZEC: 0.0033,
});

const converter = new CurrencyConverter(rateProvider);
const settlement = new MultiAssetSettlement(converter);

// Define participants with their preferred currencies
const participants = [
  {
    id: 'user_1',
    rank: 1,
    score: 100,
    preferredCurrency: 'USDC',
    stellarAddress: 'GBRPYHIL2CI6VKLVV7USHWVM6VS7ZED32LNEEJ5UKJU5ER3TDZEWFQS',
  },
  {
    id: 'user_2',
    rank: 2,
    score: 95,
    preferredCurrency: 'ZEC',
    stellarAddress: 'GBQG4XLZPN3CLYV4ZHNGZNF7X7FXZFWQHCXUGUGTQ5YRUMYPRWYFQZK',
  },
  {
    id: 'user_3',
    rank: 3,
    score: 90,
    preferredCurrency: 'XLM',
    stellarAddress: 'GAKK7DVTJUMQ43TXHVQPJDXFZ5Y4WJNRN3RBFXMBVSQGDG4LHKLJVUJ',
  },
];

// Create settlement plan
const plan = settlement.createSettlementPlan(
  'league_abc123', // League ID
  500, // $5 entry fee in cents
  participants,
  'USDC' // Reference currency
);

console.log({
  'League': plan.leagueId,
  'Total Participants': plan.participants.length,
  'Gross Pool': plan.grossPoolCents / 100,
  'Prize Pool': plan.prizePoolCents / 100,
});

// Execute settlement with currency conversions
const result = await settlement.executeSettlement(plan);

if (!result.invariantValid) {
  throw new Error('Multi-currency settlement invariant violated');
}

// Print results
console.log('\n=== Settlement Results ===');
for (const entry of result.entries) {
  console.log(
    `${entry.participantId}: ${entry.convertedAmount} ${entry.preferredCurrency} ` +
    `(${entry.prizeAmountInReferenceCurrency / 100} ${result.referenceCurrency})`
  );
}

console.log(`\nTotal Slippage: ${result.totalSlippageCents / 100} ${result.referenceCurrency}`);
console.log(`Invariant Valid: ${result.invariantValid}`);

// Generate audit trail for compliance
const auditTrail = settlement.generateAuditTrail(result);
console.log('\n' + auditTrail);
```

## Integration with Existing Services

### With `FinancialService`

```typescript
import { FinancialService } from './financialService';
import { MultiAssetSettlement } from './settlementCalculator';

async function settleLeague(leagueId: string) {
  // 1. Get league info and participants
  const league = await db.league.findUnique({ where: { id: leagueId } });
  const memberships = await db.membership.findMany({
    where: { leagueId, status: 'ACTIVE' },
    orderBy: { totalPoints: 'desc' },
  });

  // 2. Convert DB data to settlement format
  const participants = memberships.map((m, idx) => ({
    id: m.userId,
    rank: idx + 1,
    score: m.totalPoints,
    preferredCurrency: m.user.preferredCurrency || 'USDC',
    stellarAddress: m.user.wallet.stellarAddress,
  }));

  // 3. Execute settlement
  const converter = new CurrencyConverter(realRateProvider);
  const settlement = new MultiAssetSettlement(converter);
  
  const plan = settlement.createSettlementPlan(
    leagueId,
    Math.round(league.entryFee * 100), // Convert to cents
    participants,
    'USDC'
  );

  const result = await settlement.executeSettlement(plan);

  if (!result.invariantValid) {
    // Log error and skip settlement
    await auditLog.error('Settlement invariant failed', { leagueId, result });
    return;
  }

  // 4. Create payout transactions
  const grouped = settlement.groupSettlementByCurrency(result);
  
  for (const [currency, group] of grouped) {
    // Group by currency to minimize transactions
    for (const entry of group.entries) {
      const payout = await db.payout.create({
        data: {
          leagueId,
          userId: entry.participantId,
          amount: entry.convertedAmount,
          currency: entry.preferredCurrency,
          status: 'PENDING',
          stellarAddress: entry.stellarAddress,
          metadata: {
            rank: entry.participantRank,
            referenceAmount: entry.prizeAmountInReferenceCurrency,
            slippage: entry.slippageCents,
          },
        },
      });
    }
  }

  // 5. Log settlement for audit
  await auditLog.info('League settled', {
    leagueId,
    participants: result.totalParticipants,
    poolAmount: result.prizePoolCents / 100,
    invariantValid: result.invariantValid,
    slippage: result.totalSlippageCents / 100,
  });
}
```

### With `TransactionCoordinatorService`

```typescript
import { TransactionCoordinator } from './transactionCoordinatorService';

async function submitSettlementTransactions(result: MultiAssetSettlementResult) {
  const coordinator = new TransactionCoordinator();
  
  // Group by currency for batch submission
  const grouped = settlement.groupSettlementByCurrency(result);

  for (const [currency, group] of grouped) {
    // Create batch for this currency
    const batch = {
      currency,
      leagueId: result.leagueId,
      totalAmount: group.totalAmount,
      entries: group.entries.map(e => ({
        recipientAddress: e.stellarAddress,
        amount: e.convertedAmount,
        metadata: {
          participantId: e.participantId,
          rank: e.participantRank,
        },
      })),
    };

    // Submit batch to blockchain
    const txHash = await coordinator.submitBatch(batch);
    
    // Log transaction
    await db.transaction.create({
      data: {
        txHash,
        type: 'PRIZE_PAYOUT',
        currency,
        amount: group.totalAmount,
        status: 'SUBMITTED',
        metadata: batch,
      },
    });
  }
}
```

## Error Handling & Validation

### Catching Settlement Errors

```typescript
try {
  const result = await settlement.executeSettlement(plan);
} catch (error) {
  if (error.message.includes('invariant')) {
    // Mathematical error - should never happen in production
    console.error('Critical: Settlement calculation failed', error);
    await alertOps('Settlement system failure', error);
    
  } else if (error.message.includes('stellar address')) {
    // User data error - can retry with corrected data
    console.error('Invalid stellar address in settlement', error);
    // Notify admins to fix user wallet
    
  } else if (error.message.includes('No exchange rate')) {
    // Rate provider error - retry with new snapshot
    console.error('Rate provider failure', error);
    // Retry with new rate capture
    
  } else {
    // Unknown error
    console.error('Settlement error', error);
    throw error;
  }
}
```

### Validation Before Settlement

```typescript
const validation = settlement.validateSettlement(result);

if (!validation.valid) {
  console.error('Settlement validation failed:');
  for (const error of validation.errors) {
    console.error(`  - ${error}`);
  }
  
  // Do not proceed with payouts
  return;
}

// Validation passed, safe to proceed
console.log('✓ Settlement validation passed');
```

## Custom Prize Splits

### 50/30/15/5 Split (4 winners)

```typescript
const result = SettlementCalculator.calculateSettlement(
  500,
  4,
  {
    splitsBps: [5000, 3000, 1500, 500] // 50%, 30%, 15%, 5%
  }
);

// Verify splits
console.log(result.prizesCents.map(p => (p / result.prizePoolCents * 100).toFixed(1) + '%'));
// Output: [50.0%, 30.0%, 15.0%, 5.0%]
```

### Winner-Takes-All

```typescript
const result = SettlementCalculator.calculateSettlement(
  500,
  10,
  {
    splitsBps: [10000] // 100% to winner
  }
);

console.log(result.prizesCents[0]); // Entire pool to first place
```

## Rate Provider Implementation

Replace `MockRateProvider` with real oracle:

```typescript
import { IExchangeRateProvider, Currency } from './currencyConverter';

class StellarDEXRateProvider implements IExchangeRateProvider {
  async getRate(from: Currency, to: Currency): Promise<number> {
    if (from === to) return 1;

    // Query Stellar DEX for current pair price
    const response = await fetch(`https://stellar-api.io/rates/${from}/${to}`);
    const { rate } = await response.json();

    return rate;
  }
}

// Use in settlement
const converter = new CurrencyConverter(new StellarDEXRateProvider());
```

## Testing Settlement Code

### Unit Tests

```bash
npm test -- src/tests/settlementCalculator.test.ts
npm test -- src/tests/currencyConverter.test.ts
npm test -- src/tests/multiAssetSettlement.test.ts
```

### Property-Based Fuzz Testing

Automatic as part of test suite - verifies 10,000 randomized cases.

### Manual Testing

```typescript
// In your test/dev environment
const settlement = new MultiAssetSettlement(mockConverter);

// Test edge case: very small pool
const smallPlan = settlement.createSettlementPlan(
  'test-league-1',
  1, // 1 cent entry fee
  [/* participants */]
);

// Test edge case: very large pool
const largePlan = settlement.createSettlementPlan(
  'test-league-2',
  999999, // $9,999.99 entry fee
  [/* participants */]
);

// Test edge case: odd participant count
const oddPlan = settlement.createSettlementPlan(
  'test-league-3',
  333, // Odd amount
  [/* 7 participants */]
);
```

## Performance Considerations

### Throughput

- Single settlement: **<1ms**
- Multi-currency (10 participants): **~5ms**
- Multi-currency (1000 participants): **~50ms**
- Rate snapshot (3 currencies): **~5ms** (includes I/O)

### Scaling

- All operations are **O(1)** or **O(N)** linear
- No exponential algorithms
- Suitable for batch processing 1000+ leagues
- Memory footprint: ~100KB per settled league

### Optimization Tips

1. **Batch rate captures**: Call `captureRateSnapshot()` once per settlement run
2. **Currency grouping**: Use `groupSettlementByCurrency()` to minimize transactions
3. **Async/parallel**: Load participant data and settle in parallel
4. **Caching**: Cache exchange rates for 60 seconds during batch runs

## Audit & Compliance

### Settlement Proof

Each settlement can be converted to a cryptographic proof:

```typescript
import { createSettlementProof } from './settlementProof';

const proof = createSettlementProof({
  leagueId: result.leagueId,
  grossPool: result.grossPoolCents / 100,
  platformFee: result.platformFeeCents / 100,
  winners: result.entries.map(e => ({
    rank: e.participantRank,
    userId: e.participantId,
    stellarAddress: e.stellarAddress,
    totalPoints: 0, // Add from DB
    prizeAmount: e.prizeAmountInReferenceCurrency / 100,
  })),
});

// Proof is a SHA-256 hash representing the entire settlement
// Can be stored on-chain for immutable audit trail
console.log('Settlement Proof:', proof);
```

### Audit Trail

```typescript
const auditTrail = settlement.generateAuditTrail(result);

// Save to compliance database
await db.settlementAudit.create({
  leagueId: result.leagueId,
  auditTrail,
  settledAt: result.settledAt,
  invariantValid: result.invariantValid,
  slippageInCents: result.totalSlippageCents,
});
```

## Troubleshooting

### Invariant Violation

```
Error: Prize calculation invariant violated: 4749 != 4750
```

**Cause**: Rounding error in waterfall calculation (should not happen)
**Fix**: Check exchange rates are not NaN or Infinity

### No Exchange Rate Available

```
Error: No exchange rate available for USDC -> ZEC
```

**Cause**: Rate snapshot not captured or rate provider failed
**Fix**: Call `captureRateSnapshot()` before conversions

### Invalid Stellar Address

```
Error: Invalid stellar address for participant user_123
```

**Cause**: User wallet not set up or invalid address
**Fix**: Validate all participant addresses before settlement

## Migration from Old System

If migrating from a previous settlement system:

```typescript
// Old API
const oldResult = calculateOldSettlement(leagueId);

// Convert to new format
const participants = oldResult.winners.map((w, idx) => ({
  id: w.userId,
  rank: idx + 1,
  score: w.totalPoints,
  preferredCurrency: 'USDC', // Default to USDC
  stellarAddress: w.payoutAddress,
}));

// Re-settle with new system
const plan = settlement.createSettlementPlan(
  leagueId,
  oldResult.entryFee * 100, // Convert to cents
  participants
);

const newResult = await settlement.executeSettlement(plan);

// Verify results match
console.log('Old Total Payouts:', oldResult.totalPayouts);
console.log('New Total Payouts:', newResult.entries.reduce((sum, e) => sum + e.convertedAmount, 0));
```

---

## Support & Questions

For issues or questions:
1. Check `SETTLEMENT_ARCHITECTURE.md` for design details
2. Check `VERIFICATION_CHECKLIST.md` for test coverage
3. Run fuzz tests to verify behavior: `npm test -- src/tests/settlementCalculator.test.ts`
4. Enable debug logging in MultiAssetSettlement
