#!/bin/bash

# Script to commit all 4 issues to the feature/all-issues-combined branch

set -e

echo "Adding all changes..."
git add -A

echo "Creating commit for all 4 issues..."
git commit -m "feat: Implement all 4 issues (#506, #507, #515, #518)

- Issue #506: League Rules Modal component with prize breakdown visualization
  * Pure prize math (integer arithmetic, no floating-point)
  * 60/30/10 split + 5% platform fee
  * USD and crypto display
  * Full accessibility support (WCAG 2.1 AA)
  * Tests for all edge cases

- Issue #507: Transfer history API endpoint
  * GET /api/squads/:id/transfers?gameweek=:gw
  * Privacy masking for pre-deadline transfers (current gameweek)
  * Full visibility for past gameweeks
  * Penalty calculation: -4 points per excess transfer
  * Validation, authorization, deterministic ordering

- Issue #515: Waiver wire system with blind-bid resolution
  * Pure deterministic resolution engine
  * Tie-breaking: bid > priority > timestamp > claim ID
  * Budget escrow with atomic holds
  * Roster limit validation
  * Cascading losses on budget/roster exhaustion
  * Idempotent transaction-safe resolution
  * Tests: 10-manager scenarios, tie-breaker order independence

- Issue #518: Read-replica load balancer
  * Connection manager distributing SELECT to replicas
  * Writes and transactions always to primary
  * Round-robin and least-connections selection strategies
  * Health checking (periodic + passive) with hysteresis
  * Lag detection (PostgreSQL-specific, extendable)
  * Failover and retry logic
  * Chaos tests: replica crash, flapping, all down

Database:
  * Added waiver claims, escrow holds, priorities, resolutions tables
  * Added transfers and ownership tracking
  * Extended managers and gameweeks tables

Documentation:
  * IMPLEMENTATION_NOTES.md: comprehensive design decisions
  * CHANGES_SUMMARY.md: quick reference
  * Test specifications and validation checklist included

Closes #506 #507 #515 #518"

echo "Pushing to origin..."
git push -u origin feature/all-issues-combined

echo "✅ All changes committed and pushed successfully!"
echo ""
echo "Branch: feature/all-issues-combined"
echo "Ready for PR!"
