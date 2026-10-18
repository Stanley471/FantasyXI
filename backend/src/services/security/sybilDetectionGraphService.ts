import type { PrismaClient } from "@prisma/client";
import { getRedisClient, IRedisCacheClient } from "../../config/redis.js";
import { stellarConfig } from "../../config/stellar.js";
import { LeagueStatus } from "../../types/index.js";
import {
  AccountSignals,
  SybilGraphEdge,
  SybilGraphOptions,
  SybilGraphReport,
  UserRiskAssessment,
  analyzeSybilGraph,
} from "./sybilDetectionGraph.js";
import {
  securityAnomalyLog as defaultAnomalyLog,
  SecurityAnomalyLog,
  SecurityAnomalyType,
} from "./securityAnomalyLog.js";
import { KnownDevice, loginSecurityService } from "./loginSecurityService.js";

/**
 * SybilDetectionGraphService (issue #274).
 *
 * Gathers per-account signals (wallet funding lineage from Horizon, login
 * signatures from the login-security device history, squad submissions from
 * PostgreSQL), runs the graph analysis in sybilDetectionGraph.ts, caches the
 * resulting report (Redis, with in-memory fallback) and records newly
 * flagged accounts in the security anomaly log for admin review.
 *
 * Review only: funds are never frozen or confiscated automatically.
 */

export interface SybilAnalysisScope {
  /** Restrict analysis to one league's members; default: every paid league in play. */
  leagueId?: string;
}

export interface SybilSignalSource {
  loadAccountSignals(scope: SybilAnalysisScope): Promise<AccountSignals[]>;
}

export interface FunderResolver {
  /** Addresses that created/funded `address` (empty when unknown). */
  resolveFunders(address: string): Promise<string[]>;
}

/**
 * Looks up who created a Stellar account: the `funder` of its first
 * `create_account` operation on Horizon. Lineage never changes, so results
 * (including "unknown") are cached for a long time.
 */
export class HorizonFunderResolver implements FunderResolver {
  private readonly memory = new Map<string, string[]>();

  constructor(
    private readonly options: {
      horizonUrl?: string;
      redis?: IRedisCacheClient | null;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      cacheTtlSeconds?: number;
    } = {}
  ) {}

  public async resolveFunders(address: string): Promise<string[]> {
    const cacheKey = `sybil:funder:${address}`;
    const memoryHit = this.memory.get(address);
    if (memoryHit) return memoryHit;

    const redis = this.options.redis;
    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as string[];
          this.memory.set(address, parsed);
          return parsed;
        }
      } catch {
        // Fall through to Horizon
      }
    }

    const horizonUrl = (this.options.horizonUrl ?? stellarConfig.horizonUrl).replace(/\/$/, "");
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let funders: string[] = [];
    try {
      const response = await fetchImpl(
        `${horizonUrl}/accounts/${encodeURIComponent(address)}/operations?order=asc&limit=1`,
        { signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000) }
      );
      if (!response.ok) {
        // 404 = account does not exist on this network; anything else is transient
        if (response.status !== 404) return [];
      } else {
        const body = (await response.json()) as {
          _embedded?: { records?: Array<{ type?: string; funder?: string }> };
        };
        const first = body._embedded?.records?.[0];
        if (first?.type === "create_account" && first.funder) funders = [first.funder];
      }
    } catch {
      return []; // Transient: do not cache, retry on the next analysis
    }

    this.memory.set(address, funders);
    if (redis) {
      redis
        .set(cacheKey, JSON.stringify(funders), "EX", this.options.cacheTtlSeconds ?? 30 * 24 * 60 * 60)
        .catch(() => undefined);
    }
    return funders;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Loads account signals from PostgreSQL, the device history and Horizon. */
export class PrismaSybilSignalSource implements SybilSignalSource {
  constructor(
    private readonly deps: {
      db?: PrismaClient;
      devices?: { getKnownDevices(userId: string): Promise<KnownDevice[]> };
      funderResolver?: FunderResolver;
      /** Upper bound on accounts analysed in one run. Default 5000. */
      maxAccounts?: number;
    } = {}
  ) {}

  private async db(): Promise<PrismaClient> {
    if (this.deps.db) return this.deps.db;
    return (await import("../../config/db.js")).prisma;
  }

  public async loadAccountSignals(scope: SybilAnalysisScope): Promise<AccountSignals[]> {
    const db = await this.db();
    const devices = this.deps.devices ?? loginSecurityService;
    const funderResolver = this.deps.funderResolver ?? new HorizonFunderResolver({ redis: getRedisClient() });

    const members = await db.leagueMember.findMany({
      where: scope.leagueId
        ? { leagueId: scope.leagueId }
        : {
            league: {
              entryFee: { gt: 0 },
              status: { in: [LeagueStatus.UPCOMING, LeagueStatus.ACTIVE] },
            },
          },
      select: { userId: true, leagueId: true, squadId: true, stellarAddress: true },
      take: (this.deps.maxAccounts ?? 5000) * 4,
    });

    const userIds = [...new Set(members.map((m) => m.userId))].slice(0, this.deps.maxAccounts ?? 5000);
    if (userIds.length === 0) return [];

    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        username: true,
        wallet: { select: { stellarAddress: true } },
        squads: {
          select: { id: true, updatedAt: true, players: { select: { playerId: true } } },
        },
      },
    });

    const leaguesBySquad = new Map<string, string[]>();
    const payoutAddresses = new Map<string, Set<string>>();
    for (const member of members) {
      const leagues = leaguesBySquad.get(member.squadId) ?? [];
      leagues.push(member.leagueId);
      leaguesBySquad.set(member.squadId, leagues);
      if (member.stellarAddress) {
        const set = payoutAddresses.get(member.userId) ?? new Set<string>();
        set.add(member.stellarAddress);
        payoutAddresses.set(member.userId, set);
      }
    }

    return mapWithConcurrency(users, 8, async (user) => {
      const wallets = new Set<string>(payoutAddresses.get(user.id) ?? []);
      if (user.wallet?.stellarAddress) wallets.add(user.wallet.stellarAddress);
      const walletAddresses = [...wallets];

      const [funders, knownDevices] = await Promise.all([
        Promise.all(walletAddresses.map((a) => funderResolver.resolveFunders(a))),
        devices.getKnownDevices(user.id).catch(() => [] as KnownDevice[]),
      ]);

      return {
        userId: user.id,
        username: user.username,
        walletAddresses,
        funderAddresses: [...new Set(funders.flat())],
        logins: knownDevices.map((d) => ({ ip: d.ip, userAgent: d.userAgent })),
        squadSubmissions: user.squads
          .filter((squad) => leaguesBySquad.has(squad.id))
          .map((squad) => ({
            squadId: squad.id,
            leagueIds: leaguesBySquad.get(squad.id) ?? [],
            playerIds: squad.players.map((p) => p.playerId),
            // Squads keep no submission history; the last edit approximates
            // when the current lineup was submitted.
            submittedAt: squad.updatedAt,
          })),
      };
    });
  }
}

export interface UserSybilBreakdown {
  userId: string;
  assessment: UserRiskAssessment | null;
  riskScore: number;
  clusterId: string | null;
  clusterMembers: string[];
  connections: SybilGraphEdge[];
  generatedAt: string;
}

export interface SybilDetectionGraphServiceOptions {
  source?: SybilSignalSource;
  redis?: IRedisCacheClient | null;
  anomalyLog?: SecurityAnomalyLog;
  /** How long a generated report is reused. Default 10 minutes. */
  cacheTtlSeconds?: number;
  graphOptions?: Partial<SybilGraphOptions>;
}

export class SybilDetectionGraphService {
  private readonly source: SybilSignalSource;
  private readonly redis: IRedisCacheClient | null;
  private readonly anomalyLog: SecurityAnomalyLog;
  private readonly cacheTtlSeconds: number;
  private readonly graphOptions: Partial<SybilGraphOptions>;
  private readonly memory = new Map<string, { report: SybilGraphReport; expiresAt: number }>();
  private readonly alreadyFlagged = new Map<string, string>();

  constructor(options: SybilDetectionGraphServiceOptions = {}) {
    this.source = options.source ?? new PrismaSybilSignalSource();
    this.redis = options.redis !== undefined ? options.redis : getRedisClient();
    this.anomalyLog = options.anomalyLog ?? defaultAnomalyLog;
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? 600;
    this.graphOptions = options.graphOptions ?? {};
  }

  private cacheKey(scope: SybilAnalysisScope): string {
    return `sybil:report:${scope.leagueId ?? "all-paid-leagues"}`;
  }

  private async readCached(key: string): Promise<SybilGraphReport | null> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (raw) return JSON.parse(raw) as SybilGraphReport;
      } catch (err) {
        // Constant format string: the key embeds the request's leagueId
        console.warn("[security] Redis GET error for %s: %s", key, (err as Error).message);
      }
    }
    const entry = this.memory.get(key);
    return entry && Date.now() < entry.expiresAt ? entry.report : null;
  }

  private async writeCached(key: string, report: SybilGraphReport): Promise<void> {
    this.memory.set(key, { report, expiresAt: Date.now() + this.cacheTtlSeconds * 1000 });
    if (this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(report), "EX", this.cacheTtlSeconds);
      } catch (err) {
        // Constant format string: the key embeds the request's leagueId
        console.warn("[security] Redis SET error for %s: %s", key, (err as Error).message);
      }
    }
  }

  /** Logs accounts that are newly flagged (or moved cluster) since the last run. */
  private recordFlags(report: SybilGraphReport): void {
    for (const user of report.flaggedUsers) {
      const marker = user.clusterId ?? "unclustered";
      if (this.alreadyFlagged.get(user.userId) === marker) continue;
      this.alreadyFlagged.set(user.userId, marker);
      const cluster = report.clusters.find((c) => c.clusterId === user.clusterId);
      this.anomalyLog.record({
        type: SecurityAnomalyType.SYBIL_CLUSTER_SUSPECTED,
        userId: user.userId,
        identifier: marker,
        ip: "n/a",
        detail: {
          riskScore: user.riskScore,
          rating: user.rating,
          clusterSize: cluster?.size ?? 1,
          signals: user.signals,
        },
      });
    }
  }

  /** Returns the cached report for `scope`, or analyses afresh when stale or `refresh` is set. */
  public async generateReport(
    scope: SybilAnalysisScope = {},
    options: { refresh?: boolean } = {}
  ): Promise<SybilGraphReport> {
    const key = this.cacheKey(scope);
    if (!options.refresh) {
      const cached = await this.readCached(key);
      if (cached) return cached;
    }

    const accounts = await this.source.loadAccountSignals(scope);
    const report = analyzeSybilGraph(accounts, this.graphOptions);
    await this.writeCached(key, report);
    this.recordFlags(report);
    return report;
  }

  /** One account's risk, cluster and the evidence edges touching it. */
  public async getUserBreakdown(
    userId: string,
    scope: SybilAnalysisScope = {},
    options: { refresh?: boolean } = {}
  ): Promise<UserSybilBreakdown> {
    const report = await this.generateReport(scope, options);
    const assessment = report.flaggedUsers.find((u) => u.userId === userId) ?? null;
    const connections = report.clusters
      .flatMap((c) => c.edges)
      .filter((e) => e.source === userId || e.target === userId);
    const cluster = report.clusters.find((c) => c.members.includes(userId)) ?? null;
    // Flagged accounts carry their full risk score; for others the report only
    // retains cluster-strength edges, so the score reflects those connections.
    const riskScore =
      assessment?.riskScore ??
      Math.round((1 - connections.reduce((acc, e) => acc * (1 - e.confidence), 1)) * 1000) / 1000;

    return {
      userId,
      assessment,
      riskScore,
      clusterId: cluster?.clusterId ?? null,
      clusterMembers: cluster?.members ?? [],
      connections,
      generatedAt: report.generatedAt,
    };
  }
}

export const sybilDetectionGraphService = new SybilDetectionGraphService();
