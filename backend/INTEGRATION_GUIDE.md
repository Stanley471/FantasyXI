# Formation Auto-Correction Engine - Integration Guide

## Quick Start

### 1. Enable Auto-Corrections on Postponement Event

In your fixture postponement handler (e.g., in `fixtureReschedulingReconciler.ts`):

```typescript
import { formationCorrectionEngine, PostponementEvent } from "../services/squad/formationCorrectionEngine.js";

// After detecting postponements and updating fixture status
async function handleFixturePostponement(gameweekId: number, affectedFixtures: any[]) {
  // Your existing postponement logic...

  // NEW: Trigger formation auto-corrections
  const event: PostponementEvent = {
    gameweekId,
    fixturesAffected: affectedFixtures.map(f => ({
      fixtureId: f.id,
      homeTeamId: f.homeTeamId,
      awayTeamId: f.awayTeamId
    }))
  };

  try {
    const batch = await formationCorrectionEngine.processPostponement(event);
    
    logger.info(`Formation corrections: ${batch.successCount} succeeded, ${batch.failureCount} failed`);
    
    // Optional: Send notifications to users with failed corrections
    for (const result of batch.squadsCorrected) {
      if (!result.applied && result.error) {
        await notifyUserOfManualReview(result.userId, result.squadId, result.error);
      }
    }
  } catch (error) {
    logger.error(`Formation correction batch failed: ${error}`);
    // Don't re-throw; postponement processing continues
  }
}
```

### 2. Add API Endpoint for Correction History

In your squad controller:

```typescript
import { formationCorrectionEngine } from "../services/squad/formationCorrectionEngine.js";

// GET /api/squads/:squadId/corrections
async function getSquadCorrectionHistory(req: Request, res: Response) {
  const { squadId } = req.params;
  const limit = parseInt(req.query.limit as string) || 10;

  try {
    const history = await formationCorrectionEngine.getCorrectionHistory(squadId, limit);
    
    res.json({
      squadId,
      corrections: history.map(log => ({
        gameweekId: log.gameweekId,
        originalFormation: log.originalFormation,
        correctedFormation: log.correctedFormation,
        substitutionCount: log.substitutionCount,
        captainChanged: log.captainChanged,
        viceCaptainChanged: log.viceCaptainChanged,
        appliedAt: log.appliedAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to retrieve correction history" });
  }
}
```

### 3. Add Database Migration

Create a new migration file:

```bash
npx prisma migrate create add_squad_formation_correction_log
```

Add to migration file:

```sql
-- CreateSquadFormationCorrectionLog
CREATE TABLE squad_formation_correction_log (
  id SERIAL PRIMARY KEY,
  squad_id VARCHAR(36) NOT NULL,
  gameweek_id INTEGER,
  original_formation VARCHAR(10),
  corrected_formation VARCHAR(10),
  substitution_count INTEGER,
  captain_changed BOOLEAN DEFAULT false,
  vice_captain_changed BOOLEAN DEFAULT false,
  execution_log JSONB,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (squad_id) REFERENCES squads(id) ON DELETE CASCADE,
  INDEX (squad_id),
  INDEX (applied_at)
);
```

Update `schema.prisma`:

```prisma
model SquadFormationCorrectionLog {
  id                    Int     @id @default(autoincrement())
  squadId               String  @map("squad_id")
  gameweekId            Int?    @map("gameweek_id")
  originalFormation     String  @map("original_formation") @db.VarChar(10)
  correctedFormation    String  @map("corrected_formation") @db.VarChar(10)
  substitutionCount     Int     @map("substitution_count")
  captainChanged        Boolean @default(false) @map("captain_changed")
  viceCaptainChanged    Boolean @default(false) @map("vice_captain_changed")
  executionLog          Json?   @map("execution_log")
  appliedAt             DateTime @default(now()) @map("applied_at")

  squad Squad @relation(fields: [squadId], references: [id], onDelete: Cascade)

  @@map("squad_formation_correction_log")
}
```

### 4. Update Squad Model

In `schema.prisma`:

```prisma
model Squad {
  // ... existing fields ...
  
  // Add this relation
  formationCorrectionLogs SquadFormationCorrectionLog[]
}
```

## Monitoring & Observability

### Key Metrics to Track

```typescript
// In your monitoring setup
interface FormationCorrectionMetrics {
  totalPostponements: number;
  squadsAffected: number;
  successfulCorrections: number;
  failedCorrections: number;
  averageCorrectionTime: number; // ms
  commonDeficits: Map<Position, number>;
  captainCorrectionRate: number;
  viceCaptainCorrectionRate: number;
}
```

### Log Patterns to Monitor

```
// Success indicator
"Formation corrections: 523 succeeded, 12 failed"

// Warning indicators
"No available {position} on bench to fill deficit"
"Both captain and vice-captain unavailable"
"Formation {formation} does not meet minimum requirements"

// Error indicators
"Fatal error in postponement processing"
"Database transaction failed"
```

## Testing Integration

### Unit Tests (Run Before Deployment)

```bash
npm test -- src/tests/formationAutoCorrector.test.ts
# Expected: 31 tests passing
```

### Integration Tests (Run Before Deployment)

```bash
npm run test:integration
# Expected: 12+ integration tests passing
```

### Manual Testing Workflow

1. **Setup Test Squad**
   ```typescript
   const testSquad = {
     starters: [
       // 1 GKP, 4 DEF, 4 MID, 2 FWD (4-4-2)
     ],
     bench: [
       // 1 GKP, 1 DEF, 1 MID, 1 FWD
     ],
     captain: playerId1,
     viceCaptain: playerId2
   };
   ```

2. **Simulate Postponement**
   ```typescript
   const impact: FixtureImpact = {
     unavailablePlayers: new Set([defPlayer2Id]), // Defender postponed
     affectedStarters: [{ playerId: defPlayer2Id, position: Position.DEF }],
     affectedBench: []
   };
   ```

3. **Generate Correction**
   ```typescript
   const correction = FormationAutoCorrector.correctFormation(testSquad, impact);
   console.log(correction);
   // Expected:
   // - originalFormation: "4-4-2"
   // - correctedFormation: "4-4-2"
   // - substitutions: 1 (DEF out, bench DEF in)
   // - isValid: true
   ```

4. **Verify Database State**
   ```sql
   SELECT * FROM squad_formation_correction_log 
   WHERE squad_id = 'test-squad-id'
   ORDER BY applied_at DESC LIMIT 1;
   ```

## Error Handling Workflow

### Scenario: Invalid Formation Correction

```typescript
// If correction fails validation
if (!correction.isValid) {
  // Log detailed error
  logger.warn({
    squadId: squad.id,
    userId: squad.userId,
    errors: correction.errors,
    executionLog: correction.executionLog
  });

  // Option 1: Manual review queue
  await addToManualReviewQueue({
    squadId: squad.id,
    reason: "Auto-correction generated invalid formation",
    details: correction.errors
  });

  // Option 2: Notify user
  await sendUserNotification(squad.userId, {
    type: "FORMATION_CORRECTION_FAILED",
    squadId: squad.id,
    message: "Your squad couldn't be auto-corrected. Please update manually.",
    helpLink: "/help/formation-correction"
  });
}
```

### Scenario: Database Transaction Failure

```typescript
// Engine handles internally - no action needed
// But log for monitoring

logger.error({
  event: "FORMATION_CORRECTION_TRANSACTION_FAILED",
  squadId: squad.id,
  reason: error.message,
  timestamp: new Date()
});

// Squad state is preserved (rollback)
// Retry can be attempted manually or via job queue
```

## Performance Optimization

### For Large Postponements (500+ squads)

```typescript
// Batch process with concurrency control
async function processPostponementOptimized(event: PostponementEvent) {
  const concurrency = 5; // Process 5 squads in parallel
  const batcher = new PQueue({ concurrency });

  const squadIds = await findAllAffectedSquads(event);
  
  const results = await Promise.all(
    squadIds.map(squadId => 
      batcher.add(() => formationCorrectionEngine.correctSquadFormation(squad, affected))
    )
  );

  return results;
}
```

### Caching Formation Validations

```typescript
// If same formation checked multiple times
import Cache from 'cache-module'; // Your caching solution

const formationCache = new Cache<string, boolean>({
  ttl: 3600 // 1 hour
});

public static isLegalFormation(formation: string): boolean {
  const cached = formationCache.get(formation);
  if (cached !== undefined) return cached;

  const result = this._validateFormation(formation);
  formationCache.set(formation, result);
  return result;
}
```

## Rollout Strategy

### Phase 1: Development
- ✅ All tests passing locally
- ✅ Manual testing complete
- ✅ Code review approved

### Phase 2: Staging
- Deploy to staging environment
- Run integration tests against staging DB
- Monitor for 48 hours
- Test with production-like data volume

### Phase 3: Canary Deployment (5% of users)
- Deploy to production with feature flag
- Monitor error rates and correction success rate
- Verify database performance
- Check user notifications reaching correctly

### Phase 4: Full Rollout
- Enable for 100% of users
- Monitor metrics continuously
- Keep rollback plan ready

## Rollback Procedure

If issues arise post-deployment:

```bash
# Option 1: Disable new corrections (keep validation)
# Set environment variable:
export DISABLE_AUTO_CORRECTIONS=true

# Option 2: Full rollback
git revert <commit-hash>
npm run build
npm run db:migrate  # Reverse migration if needed

# Option 3: Manual cleanup
UPDATE squads SET formation_status = 'NEEDS_REVIEW'
WHERE id IN (SELECT squad_id FROM squad_formation_correction_log 
             WHERE applied_at > '2025-11-20');
```

## Support & Troubleshooting

### Common Issues

**Issue:** "No available {position} on bench"
```
Solution: User's bench was also affected by postponement.
Manual intervention required. Escalate to user support.
```

**Issue:** "Formation does not meet minimum requirements"
```
Solution: Insufficient viable subs on bench. Rare edge case.
Manual correction recommended. Log for review.
```

**Issue:** Slow correction processing
```
Solution: Check database indexes on squad_players table.
Verify no long-running transactions blocking updates.
Monitor concurrent correction jobs.
```

## Support Contacts

- **Formation Logic Issues:** Backend Team
- **Database Migration Issues:** DBA Team  
- **User Notifications:** Platform Team
- **Performance Issues:** DevOps Team

## Additional Resources

- [Formation Auto-Correction Detailed Documentation](./src/services/squad/FORMATION_AUTO_CORRECTION.md)
- [Test Coverage Report](./src/tests/formationAutoCorrector.test.ts)
- [Integration Tests](./src/tests/formationCorrectionEngine.integration.test.ts)
- [Implementation Summary](./IMPLEMENTATION_SUMMARY.md)

---

**Integration Ready:** Yes  
**Estimated Integration Time:** 2-4 hours  
**Risk Level:** Low (feature-flagged, no breaking changes)  
**Last Updated:** 2025-11-20
