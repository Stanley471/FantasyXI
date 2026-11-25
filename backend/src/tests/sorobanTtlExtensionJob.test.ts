import test from "node:test";
import assert from "node:assert/strict";
import { LeagueStatus, type PrismaClient } from "@prisma/client";
import {
  runSorobanTtlExtensionJob,
  SOROBAN_TTL_EXTENSION_JOB_NAME,
  SOROBAN_TTL_EXTENSION_CRON,
  TTL_SAFETY_THRESHOLD_LEDGERS,
  TTL_MAX_EXTEND_BOUNDARY_LEDGERS,
} from "../jobs/sorobanTtlExtension.js";
import {
  SorobanContractClient,
  type InvocationResult,
} from "../services/financial/sorobanContractClient.js";
import { toContractLeagueId } from "../services/financial/contractLeagueId.js";

test("runSorobanTtlExtensionJob correctly identifies contracts with < 100,000 ledgers and bumps to max boundary", async () => {
  const expiringLeagueId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const safeLeagueId = "11111111-2222-3333-4444-555555555555";
  const expiringContractLeagueId = toContractLeagueId(expiringLeagueId);
  const safeContractLeagueId = toContractLeagueId(safeLeagueId);

  const bumpedInstances: Array<{ secret: string; extendTo: number }> = [];
  const bumpedDataEntries: Array<{
    secret: string;
    contractLeagueId: bigint;
    extendTo: number;
  }> = [];

  const mockClient = {
    getContractInstanceTtl: async () => ({
      liveUntilLedgerSeq: 180_000,
      remainingLedgers: 80_000, // < 100_000, must be bumped!
      currentLedgerSeq: 100_000,
    }),
    getLeagueEntryTtl: async (leagueId: bigint) => {
      if (leagueId === expiringContractLeagueId) {
        return {
          liveUntilLedgerSeq: 150_000,
          remainingLedgers: 50_000, // < 100_000, must be bumped!
          currentLedgerSeq: 100_000,
        };
      }
      if (leagueId === safeContractLeagueId) {
        return {
          liveUntilLedgerSeq: 400_000,
          remainingLedgers: 300_000, // >= 100_000, safe!
          currentLedgerSeq: 100_000,
        };
      }
      return null;
    },
    extendContractInstanceTtl: async (secret: string, extendTo: number) => {
      bumpedInstances.push({ secret, extendTo });
      return {
        success: true,
        txHash: "tx-hash-instance-bump-999",
        gasConsumed: "14500",
      };
    },
    extendContractDataTtl: async (
      secret: string,
      contractLeagueId: bigint,
      extendTo: number
    ) => {
      bumpedDataEntries.push({ secret, contractLeagueId, extendTo });
      return {
        success: true,
        txHash: `tx-hash-league-${contractLeagueId}`,
        gasConsumed: "18200",
      };
    },
  } as unknown as SorobanContractClient;

  const mockPrisma = {
    league: {
      findMany: async () => [
        {
          id: expiringLeagueId,
          status: LeagueStatus.ACTIVE,
          name: "Expiring League",
        },
        {
          id: safeLeagueId,
          status: LeagueStatus.UPCOMING,
          name: "Safe League",
        },
      ],
    },
  } as unknown as PrismaClient;

  const logs: string[] = [];
  const mockLogger = {
    log: (msg: string) => logs.push(msg),
    warn: (msg: string) => logs.push(msg),
    error: (msg: string) => logs.push(msg),
  };

  const report = await runSorobanTtlExtensionJob({
    db: mockPrisma,
    contractClient: mockClient,
    adminSecret: "SD00000000000000000000000000000000000000000000000000000000",
    logger: mockLogger,
  });

  // Verify report metrics
  assert.equal(report.contractsChecked, 3); // 1 instance + 2 leagues
  assert.equal(report.instanceExtended, true);
  assert.equal(report.leaguesScanned, 2);
  assert.equal(report.leaguesExtended, 1);
  assert.equal(report.leaguesArchivedOrMissing, 0);
  assert.equal(report.errors.length, 0);

  // Verify bump operations targeted max boundary
  assert.equal(bumpedInstances.length, 1);
  assert.equal(bumpedInstances[0].extendTo, TTL_MAX_EXTEND_BOUNDARY_LEDGERS);
  assert.equal(bumpedDataEntries.length, 1);
  assert.equal(bumpedDataEntries[0].contractLeagueId, expiringContractLeagueId);
  assert.equal(bumpedDataEntries[0].extendTo, TTL_MAX_EXTEND_BOUNDARY_LEDGERS);

  // Verify logged bump operations and gas consumption
  assert.equal(report.extensions.length, 2);
  assert.equal(report.extensions[0].type, "CONTRACT_INSTANCE");
  assert.equal(report.extensions[0].gasConsumed, "14500");
  assert.equal(report.extensions[0].txHash, "tx-hash-instance-bump-999");

  assert.equal(report.extensions[1].type, "LEAGUE_STORAGE");
  assert.equal(report.extensions[1].targetId, expiringLeagueId);
  assert.equal(report.extensions[1].gasConsumed, "18200");
  assert.equal(
    report.extensions[1].txHash,
    `tx-hash-league-${expiringContractLeagueId}`
  );

  // Verify logger recorded both gas consumption and healthy entries
  const instanceLog = logs.find((l) => l.includes("Contract instance TTL extended"));
  assert.ok(instanceLog && instanceLog.includes("gasConsumed=14500 stroops"));

  const leagueLog = logs.find((l) => l.includes("storage TTL extended"));
  assert.ok(leagueLog && leagueLog.includes("gasConsumed=18200 stroops"));

  const safeLog = logs.find((l) => l.includes("storage TTL healthy"));
  assert.ok(safeLog && safeLog.includes("300000 ledgers remaining"));
});

test("runSorobanTtlExtensionJob skips bump when all contracts have >= 100,000 ledgers", async () => {
  const safeLeagueId = "22222222-3333-4444-5555-666666666666";

  const bumpedInstances: unknown[] = [];
  const bumpedDataEntries: unknown[] = [];

  const mockClient = {
    getContractInstanceTtl: async () => ({
      liveUntilLedgerSeq: 500_000,
      remainingLedgers: 400_000, // >= 100_000
      currentLedgerSeq: 100_000,
    }),
    getLeagueEntryTtl: async () => ({
      liveUntilLedgerSeq: 500_000,
      remainingLedgers: 400_000, // >= 100_000
      currentLedgerSeq: 100_000,
    }),
    extendContractInstanceTtl: async () => {
      bumpedInstances.push(true);
      return { success: true };
    },
    extendContractDataTtl: async () => {
      bumpedDataEntries.push(true);
      return { success: true };
    },
  } as unknown as SorobanContractClient;

  const mockPrisma = {
    league: {
      findMany: async () => [
        {
          id: safeLeagueId,
          status: LeagueStatus.ACTIVE,
          name: "Safe League",
        },
      ],
    },
  } as unknown as PrismaClient;

  const report = await runSorobanTtlExtensionJob({
    db: mockPrisma,
    contractClient: mockClient,
    adminSecret: "SD00000000000000000000000000000000000000000000000000000000",
  });

  assert.equal(report.instanceExtended, false);
  assert.equal(report.leaguesExtended, 0);
  assert.equal(bumpedInstances.length, 0);
  assert.equal(bumpedDataEntries.length, 0);
  assert.equal(report.extensions.length, 0);
});

test("runSorobanTtlExtensionJob reports archived or missing league entries", async () => {
  const missingLeagueId = "33333333-4444-5555-6666-777777777777";

  const mockClient = {
    getContractInstanceTtl: async () => ({
      liveUntilLedgerSeq: 500_000,
      remainingLedgers: 400_000,
      currentLedgerSeq: 100_000,
    }),
    getLeagueEntryTtl: async () => null, // Missing / archived
  } as unknown as SorobanContractClient;

  const mockPrisma = {
    league: {
      findMany: async () => [
        {
          id: missingLeagueId,
          status: LeagueStatus.ACTIVE,
          name: "Archived League",
        },
      ],
    },
  } as unknown as PrismaClient;

  const report = await runSorobanTtlExtensionJob({
    db: mockPrisma,
    contractClient: mockClient,
    adminSecret: "SD00000000000000000000000000000000000000000000000000000000",
  });

  assert.equal(report.leaguesArchivedOrMissing, 1);
  assert.equal(report.leaguesExtended, 0);
});

test("runSorobanTtlExtensionJob handles missing admin secret gracefully with clear error", async () => {
  const expiringLeagueId = "44444444-5555-6666-7777-888888888888";

  const mockClient = {
    getContractInstanceTtl: async () => ({
      liveUntilLedgerSeq: 150_000,
      remainingLedgers: 50_000, // < 100_000
      currentLedgerSeq: 100_000,
    }),
    getLeagueEntryTtl: async () => ({
      liveUntilLedgerSeq: 140_000,
      remainingLedgers: 40_000, // < 100_000
      currentLedgerSeq: 100_000,
    }),
  } as unknown as SorobanContractClient;

  const mockPrisma = {
    league: {
      findMany: async () => [
        {
          id: expiringLeagueId,
          status: LeagueStatus.ACTIVE,
          name: "Expiring League",
        },
      ],
    },
  } as unknown as PrismaClient;

  const report = await runSorobanTtlExtensionJob({
    db: mockPrisma,
    contractClient: mockClient,
    adminSecret: "", // Intentionally missing
  });

  assert.equal(report.instanceExtended, false);
  assert.equal(report.leaguesExtended, 0);
  assert.ok(report.errors.length >= 2);
  assert.ok(report.errors.some((e) => e.includes("maintenance keypair secret missing")));
});

test("constants match issue #548 specifications", () => {
  assert.equal(SOROBAN_TTL_EXTENSION_JOB_NAME, "soroban-ttl-extension");
  assert.equal(SOROBAN_TTL_EXTENSION_CRON, "0 * * * *");
  assert.equal(TTL_SAFETY_THRESHOLD_LEDGERS, 100_000);
  assert.equal(TTL_MAX_EXTEND_BOUNDARY_LEDGERS, 518_400);
});
