import test from "node:test";
import assert from "node:assert/strict";
import {
  SorobanTtlManagerWorker,
  DEFAULT_TTL_MARGIN_LEDGERS,
  DEFAULT_TTL_EXTEND_TO_LEDGERS,
} from "../workers/sorobanTtlManagerWorker.js";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";
import { PrismaClient, LeagueStatus } from "@prisma/client";

test("SorobanTtlManagerWorker properly identifies expiring entries and triggers extension", async () => {
  const extendedLeagues: bigint[] = [];
  const testLeagueId = "11111111-2222-3333-4444-555555555555";

  // Mock contract client
  const mockClient = {
    getContractInstanceTtl: async () => ({
      liveUntilLedgerSeq: 150_000,
      remainingLedgers: 50_000, // < 86_400 (needs bump)
      currentLedgerSeq: 100_000,
    }),
    getLeagueEntryTtl: async (leagueId: bigint) => {
      return {
        liveUntilLedgerSeq: 140_000,
        remainingLedgers: 40_000, // < 86_400 (needs bump)
        currentLedgerSeq: 100_000,
      };
    },
    extendLeagueTtl: async (secret: string, leagueId: bigint) => {
      extendedLeagues.push(leagueId);
      return { success: true, txHash: "mock-tx-hash-123" };
    },
  } as unknown as SorobanContractClient;

  // Mock Prisma client with 1 active league
  const mockPrisma = {
    league: {
      findMany: async () => [
        {
          id: testLeagueId,
          status: LeagueStatus.ACTIVE,
          name: "Championship Alpha",
        },
      ],
    },
  } as unknown as PrismaClient;

  const worker = new SorobanTtlManagerWorker({
    prisma: mockPrisma,
    contractClient: mockClient,
    adminSecret: "SD00000000000000000000000000000000000000000000000000000000",
    pollIntervalMs: 60_000,
    marginThresholdLedgers: DEFAULT_TTL_MARGIN_LEDGERS,
    extendToLedgers: DEFAULT_TTL_EXTEND_TO_LEDGERS,
  });

  const summary = await worker.scanOnce();

  assert.equal(summary.totalLeaguesScanned, 1);
  assert.equal(summary.instanceExtended, true);
  assert.equal(summary.leaguesExtended, 1);
  assert.equal(summary.errors.length, 0);
  assert.equal(extendedLeagues.length, 1);
});

test("SorobanTtlManagerWorker skips extension when TTL is well above margin", async () => {
  const extendedLeagues: bigint[] = [];

  const mockClient = {
    getContractInstanceTtl: async () => ({
      liveUntilLedgerSeq: 500_000,
      remainingLedgers: 400_000, // Safe
      currentLedgerSeq: 100_000,
    }),
    getLeagueEntryTtl: async () => ({
      liveUntilLedgerSeq: 500_000,
      remainingLedgers: 400_000, // Safe
      currentLedgerSeq: 100_000,
    }),
    extendLeagueTtl: async (secret: string, leagueId: bigint) => {
      extendedLeagues.push(leagueId);
      return { success: true };
    },
  } as unknown as SorobanContractClient;

  const mockPrisma = {
    league: {
      findMany: async () => [
        {
          id: "22222222-3333-4444-5555-666666666666",
          status: LeagueStatus.UPCOMING,
          name: "Safe League",
        },
      ],
    },
  } as unknown as PrismaClient;

  const worker = new SorobanTtlManagerWorker({
    prisma: mockPrisma,
    contractClient: mockClient,
    adminSecret: "SD00000000000000000000000000000000000000000000000000000000",
  });

  const summary = await worker.scanOnce();

  assert.equal(summary.totalLeaguesScanned, 1);
  assert.equal(summary.instanceExtended, false);
  assert.equal(summary.leaguesExtended, 0);
  assert.equal(extendedLeagues.length, 0);
});

test("SorobanTtlManagerWorker flags archived/missing entries", async () => {
  const mockClient = {
    getContractInstanceTtl: async () => ({
      liveUntilLedgerSeq: 500_000,
      remainingLedgers: 400_000,
      currentLedgerSeq: 100_000,
    }),
    getLeagueEntryTtl: async () => null, // Archived or missing
  } as unknown as SorobanContractClient;

  const mockPrisma = {
    league: {
      findMany: async () => [
        {
          id: "33333333-4444-5555-6666-777777777777",
          status: LeagueStatus.ACTIVE,
          name: "Archived League",
        },
      ],
    },
  } as unknown as PrismaClient;

  const worker = new SorobanTtlManagerWorker({
    prisma: mockPrisma,
    contractClient: mockClient,
  });

  let missingEventEmitted = false;
  worker.on("ttl:league_missing", () => {
    missingEventEmitted = true;
  });

  const summary = await worker.scanOnce();

  assert.equal(summary.leaguesArchivedOrMissing, 1);
  assert.equal(missingEventEmitted, true);
});

test("SorobanTtlManagerWorker start and stop lifecycle", () => {
  const mockClient = {
    getContractInstanceTtl: async () => null,
  } as unknown as SorobanContractClient;
  const mockPrisma = {
    league: { findMany: async () => [] },
  } as unknown as PrismaClient;
  const worker = new SorobanTtlManagerWorker({ contractClient: mockClient, prisma: mockPrisma });
  assert.equal(worker.getStatus().isRunning, false);

  worker.start();
  assert.equal(worker.getStatus().isRunning, true);

  worker.stop();
  assert.equal(worker.getStatus().isRunning, false);
});
