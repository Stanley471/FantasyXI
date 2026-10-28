/**
 * Sybil / multi-account syndicate detection (issue #274).
 *
 * Builds a relationship graph over the members of a league (nodes = accounts)
 * from four independent signals, scores each account and groups linked
 * accounts into clusters for manual review by security admins. Nothing is
 * confiscated or blocked automatically.
 *
 *  - FUNDING_LINEAGE: wallets created by the same Stellar account, or one
 *    member's wallet created by another member's (Horizon create_account
 *    `funder`, cached in stellar_account_funders; immutable on-chain).
 *  - SHARED_DEVICE:   the same fingerprinted browser signed in to both accounts.
 *  - SHARED_SUBNET:   sign-ins from the same IPv4 /24 or IPv6 /64 (weak alone).
 *  - COORDINATED_SQUAD: near-identical squads (Jaccard >= minSquadOverlap)
 *    created, or changed by the same transfer, within coordinationWindowMs.
 *
 * Signals shared by more accounts than maxSignalFanout (faucets, exchanges,
 * carrier-grade NAT, campus networks) are suppressed as hubs: they would
 * otherwise link thousands of unrelated users.
 *
 * Scoring: evidence types on a pair combine by noisy-OR,
 * P(link) = 1 - prod(1 - w_type), so independent weak signals reinforce each
 * other; pairs at or above minLinkConfidence become edges. Clusters are the
 * connected components (union-find), and an account's risk is the noisy-OR of
 * its edge confidences.
 *
 * Complexity for N members, S signal rows, A addresses and C candidate pairs:
 * grouping O(S + A); pair evidence O(sum of k^2) over groups of size
 * k <= maxSignalFanout; squad candidates O(N log N + T log T + C) with T
 * transfers, each compared in O(15); union-find O(E * alpha(N)). Space is
 * O(S + A + T + C).
 */

import { Horizon } from "@stellar/stellar-sdk";
import { prisma as defaultPrisma } from "../../config/db.js";
import { getRedisClient, IRedisCacheClient } from "../../config/redis.js";
import { withHorizonFailover } from "../../config/stellar.js";
import {
  securityAnomalyLog as defaultAnomalyLog,
  SecurityAnomalyLog,
  SecurityAnomalyType,
} from "./securityAnomalyLog.js";

export type SybilEvidenceType = "FUNDING_LINEAGE" | "SHARED_DEVICE" | "SHARED_SUBNET" | "COORDINATED_SQUAD";
export type SybilRating = "HIGH" | "MEDIUM" | "LOW";

export interface SybilAccountNode {
  userId: string;
  username: string;
  /** Linked wallet and league deposit addresses */
  stellarAddresses: string[];
  squad: { createdAt: Date; playerIds: number[] } | null;
  transfers: Array<{ gameweekId: number; playerInId: number; playerOutId: number; at: Date }>;
  signals: Array<{ type: "DEVICE" | "IP_SUBNET"; value: string }>;
}

export interface SybilGraphInput {
  nodes: SybilAccountNode[];
  /** Stellar address -> account that created it */
  funders: ReadonlyMap<string, string>;
  /** Platform-wide account count per signal key ("DEVICE:..", "IP_SUBNET:..", "FUNDER:..") */
  globalFanout: ReadonlyMap<string, number>;
}

export interface SybilPolicy {
  weights: Record<SybilEvidenceType, number>;
  maxSignalFanout: number;
  minLinkConfidence: number;
  flagRiskThreshold: number;
  minSquadOverlap: number;
  coordinationWindowMs: number;
  /** Only login signatures seen this recently count */
  signalLookbackMs: number;
  ignoredFunders: ReadonlySet<string>;
}

export interface SybilEvidence {
  type: SybilEvidenceType;
  confidence: number;
  /** The shared funder / device / subnet, or the squad overlap summary (at most 5) */
  values: string[];
}

export interface SybilLink {
  source: string;
  target: string;
  confidence: number;
  evidence: SybilEvidence[];
}

export interface SybilCluster {
  id: string;
  confidence: number;
  rating: SybilRating;
  members: Array<{ userId: string; username: string; riskScore: number }>;
  links: SybilLink[];
}

export interface SybilAnalysis {
  clusters: SybilCluster[];
  accounts: Array<{ userId: string; username: string; riskScore: number; clusterId: string; flagged: boolean }>;
  suppressedSignals: Array<{ signal: string; accounts: number }>;
}

export interface SybilLeagueReport extends SybilAnalysis {
  leagueId: string;
  analyzedAt: string;
  memberCount: number;
}

/** Stellar testnet Friendbot creates every testnet account: a shared funder carrying no signal. */
const TESTNET_FRIENDBOT = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR";

export const DEFAULT_SYBIL_POLICY: SybilPolicy = {
  weights: {
    FUNDING_LINEAGE: 0.85,
    SHARED_DEVICE: 0.7,
    // Households and offices share networks: needs another signal to form a link
    SHARED_SUBNET: 0.3,
    COORDINATED_SQUAD: 0.85,
  },
  maxSignalFanout: 20,
  minLinkConfidence: 0.5,
  flagRiskThreshold: 0.8,
  minSquadOverlap: 0.8,
  coordinationWindowMs: 10 * 60_000,
  signalLookbackMs: 90 * 24 * 60 * 60_000,
  ignoredFunders: new Set([TESTNET_FRIENDBOT]),
};

const SIGNAL_EVIDENCE: Record<string, SybilEvidenceType> = {
  FUNDER: "FUNDING_LINEAGE",
  DEVICE: "SHARED_DEVICE",
  IP_SUBNET: "SHARED_SUBNET",
};
const MAX_EVIDENCE_VALUES = 5;

const round = (value: number) => Math.round(value * 1000) / 1000;
const noisyOr = (probabilities: number[]) => 1 - probabilities.reduce((rest, p) => rest * (1 - p), 1);
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function ratingFor(confidence: number): SybilRating {
  return confidence >= 0.8 ? "HIGH" : confidence >= 0.6 ? "MEDIUM" : "LOW";
}

/** |A ∩ B| / |A ∪ B| of two ascending, duplicate-free arrays, in O(|A| + |B|). */
function jaccard(a: number[], b: number[]): { score: number; shared: number } {
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      shared++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  const union = a.length + b.length - shared;
  return { score: union === 0 ? 0 : shared / union, shared };
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly size = new Map<string, number>();

  public find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.size.set(x, 1);
    }
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression
    while (x !== root) {
      const next = this.parent.get(x)!;
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }

  public union(a: string, b: string): void {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) return;
    if (this.size.get(rootA)! < this.size.get(rootB)!) [rootA, rootB] = [rootB, rootA];
    this.parent.set(rootB, rootA);
    this.size.set(rootA, this.size.get(rootA)! + this.size.get(rootB)!);
  }
}

/** Pure graph analysis over already-loaded data; deterministic for a given input. */
export function analyzeSybilGraph(input: SybilGraphInput, policy: SybilPolicy = DEFAULT_SYBIL_POLICY): SybilAnalysis {
  const pairs = new Map<string, Map<SybilEvidenceType, SybilEvidence>>();
  const addEvidence = (a: string, b: string, type: SybilEvidenceType, confidence: number, value: string) => {
    if (a === b) return;
    const key = pairKey(a, b);
    let byType = pairs.get(key);
    if (!byType) pairs.set(key, (byType = new Map()));
    const existing = byType.get(type);
    if (!existing) {
      byType.set(type, { type, confidence, values: [value] });
      return;
    }
    existing.confidence = Math.max(existing.confidence, confidence);
    if (existing.values.length < MAX_EVIDENCE_VALUES && !existing.values.includes(value)) existing.values.push(value);
  };

  // 1. Inverted index: signal -> accounts sharing it
  const groups = new Map<string, Set<string>>();
  const join = (key: string, userId: string) => {
    let members = groups.get(key);
    if (!members) groups.set(key, (members = new Set()));
    members.add(userId);
  };
  for (const node of input.nodes) {
    for (const signal of node.signals) join(`${signal.type}:${signal.value}`, node.userId);
    for (const address of node.stellarAddresses) {
      // The member's own address: links it to any member whose wallet it created
      join(`FUNDER:${address}`, node.userId);
      const funder = input.funders.get(address);
      if (funder && !policy.ignoredFunders.has(funder)) join(`FUNDER:${funder}`, node.userId);
    }
  }

  const suppressedSignals: SybilAnalysis["suppressedSignals"] = [];
  for (const [key, members] of groups) {
    if (members.size < 2) continue;
    const fanout = Math.max(members.size, input.globalFanout.get(key) ?? 0);
    if (fanout > policy.maxSignalFanout) {
      suppressedSignals.push({ signal: key, accounts: fanout });
      continue;
    }
    const separator = key.indexOf(":");
    const type = SIGNAL_EVIDENCE[key.slice(0, separator)];
    const value = key.slice(separator + 1);
    const ids = [...members];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) addEvidence(ids[i], ids[j], type, policy.weights[type], value);
    }
  }

  // 2. Coordinated squads: candidate pairs are squads created, or changed by
  // the same transfer, within the window; a sliding window over time-sorted
  // events avoids comparing every pair of squads
  const window = policy.coordinationWindowMs;
  const players = new Map<string, number[]>();
  const created: Array<{ userId: string; at: number }> = [];
  const moves = new Map<string, Array<{ userId: string; at: number }>>();
  for (const node of input.nodes) {
    if (!node.squad) continue;
    players.set(node.userId, [...new Set(node.squad.playerIds)].sort((a, b) => a - b));
    created.push({ userId: node.userId, at: node.squad.createdAt.getTime() });
    for (const transfer of node.transfers) {
      const key = `${transfer.gameweekId}:${transfer.playerInId}:${transfer.playerOutId}`;
      let list = moves.get(key);
      if (!list) moves.set(key, (list = []));
      list.push({ userId: node.userId, at: transfer.at.getTime() });
    }
  }

  // Candidate pair -> number of mirrored transfers (0 when only created together)
  const candidates = new Map<string, number>();
  const coincide = (events: Array<{ userId: string; at: number }>, counts: boolean) => {
    events.sort((a, b) => a.at - b.at);
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length && events[j].at - events[i].at <= window; j++) {
        if (events[i].userId === events[j].userId) continue;
        const key = pairKey(events[i].userId, events[j].userId);
        candidates.set(key, (candidates.get(key) ?? 0) + (counts ? 1 : 0));
      }
    }
  };
  coincide(created, false);
  for (const events of moves.values()) coincide(events, true);

  for (const [key, mirroredTransfers] of candidates) {
    const [a, b] = key.split("|");
    const overlap = jaccard(players.get(a)!, players.get(b)!);
    if (overlap.score < policy.minSquadOverlap) continue;
    // Identical squads created together score half; each mirrored transfer adds an eighth
    const confidence =
      policy.weights.COORDINATED_SQUAD * overlap.score * Math.min(1, 0.5 + 0.125 * mirroredTransfers);
    addEvidence(
      a,
      b,
      "COORDINATED_SQUAD",
      confidence,
      `${overlap.shared} shared players (Jaccard ${round(overlap.score)}), ${mirroredTransfers} mirrored transfers`
    );
  }

  // 3. Edges: noisy-OR across evidence types
  const links: SybilLink[] = [];
  const unionFind = new UnionFind();
  for (const [key, byType] of pairs) {
    const evidence = [...byType.values()].map((e) => ({ ...e, confidence: round(e.confidence) }));
    const confidence = noisyOr(evidence.map((e) => e.confidence));
    if (confidence < policy.minLinkConfidence) continue;
    const [source, target] = key.split("|");
    links.push({ source, target, confidence: round(confidence), evidence });
    unionFind.union(source, target);
  }

  // 4. Clusters (connected components) and per-account risk
  const usernames = new Map(input.nodes.map((node) => [node.userId, node.username]));
  const incident = new Map<string, number[]>();
  const clusterLinks = new Map<string, SybilLink[]>();
  for (const link of links) {
    for (const userId of [link.source, link.target]) {
      let list = incident.get(userId);
      if (!list) incident.set(userId, (list = []));
      list.push(link.confidence);
    }
    const root = unionFind.find(link.source);
    let list = clusterLinks.get(root);
    if (!list) clusterLinks.set(root, (list = []));
    list.push(link);
  }
  const risk = (userId: string) => round(noisyOr(incident.get(userId) ?? []));

  const clusters: SybilCluster[] = [...clusterLinks.values()].map((clusterEdges) => {
    const memberIds = [...new Set(clusterEdges.flatMap((link) => [link.source, link.target]))];
    const confidence = round(clusterEdges.reduce((sum, link) => sum + link.confidence, 0) / clusterEdges.length);
    return {
      id: "",
      confidence,
      rating: ratingFor(confidence),
      members: memberIds
        .map((userId) => ({ userId, username: usernames.get(userId) ?? userId, riskScore: risk(userId) }))
        .sort((a, b) => b.riskScore - a.riskScore || a.userId.localeCompare(b.userId)),
      links: clusterEdges.sort((a, b) => b.confidence - a.confidence),
    };
  });
  clusters.sort((a, b) => b.confidence - a.confidence || b.members.length - a.members.length);
  clusters.forEach((cluster, index) => (cluster.id = `cluster-${index + 1}`));

  const accounts = clusters
    .flatMap((cluster) =>
      cluster.members.map((member) => ({
        ...member,
        clusterId: cluster.id,
        flagged: member.riskScore >= policy.flagRiskThreshold,
      }))
    )
    .sort((a, b) => b.riskScore - a.riskScore);

  return { clusters, accounts, suppressedSignals };
}

/** Creator of a Stellar account from its first operation; null when unknown (pruned history, missing account). */
export async function resolveStellarFunder(address: string): Promise<string | null> {
  try {
    const page = await withHorizonFailover((server) =>
      server.operations().forAccount(address).order("asc").limit(1).call()
    );
    const first = page.records[0];
    return first?.type === Horizon.HorizonApi.OperationResponseType.createAccount ? first.funder : null;
  } catch (error) {
    // 404 (no such account), 410 (before the node's retained history) or network failure
    console.warn(`[security] Could not resolve the funder of ${address}:`, (error as Error).message);
    return null;
  }
}

/** Runs `task` over `items` with at most `limit` in flight (keeps Horizon below its rate limit). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class SybilLeagueNotFoundError extends Error {
  constructor() {
    super("League not found");
    this.name = "SybilLeagueNotFoundError";
  }
}

export interface SybilDetectionOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  redis?: IRedisCacheClient | null;
  anomalyLog?: SecurityAnomalyLog;
  policy?: SybilPolicy;
  resolveFunder?: (address: string) => Promise<string | null>;
  /** Lifetime of a cached league report, in seconds. Default 10 minutes. */
  reportTtlSeconds?: number;
}

const REPORT_PREFIX = "security:sybil:league:";
const HORIZON_CONCURRENCY = 4;

export class SybilDetectionGraphService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly redis: IRedisCacheClient | null;
  private readonly anomalyLog: SecurityAnomalyLog;
  private readonly policy: SybilPolicy;
  private readonly resolveFunder: (address: string) => Promise<string | null>;
  private readonly reportTtlSeconds: number;

  constructor(options: SybilDetectionOptions = {}) {
    this.db = options.db ?? defaultPrisma;
    this.redis = options.redis !== undefined ? options.redis : getRedisClient();
    this.anomalyLog = options.anomalyLog ?? defaultAnomalyLog;
    this.policy = options.policy ?? DEFAULT_SYBIL_POLICY;
    this.resolveFunder = options.resolveFunder ?? resolveStellarFunder;
    this.reportTtlSeconds = options.reportTtlSeconds ?? 10 * 60;
  }

  /**
   * Analyzes a league's members. A report is cached in Redis for
   * reportTtlSeconds; `refresh` recomputes it. Accounts at or above the
   * flagging threshold are recorded in the security anomaly log on every
   * fresh computation.
   */
  public async analyzeLeague(leagueId: string, options: { refresh?: boolean } = {}): Promise<SybilLeagueReport> {
    const cacheKey = `${REPORT_PREFIX}${leagueId}`;
    if (!options.refresh) {
      const cached = await this.readCachedReport(cacheKey);
      if (cached) return cached;
    }

    const league = await this.db.league.findUnique({ where: { id: leagueId }, select: { id: true } });
    if (!league) throw new SybilLeagueNotFoundError();

    const nodes = await this.loadNodes(leagueId);
    const addresses = [...new Set(nodes.flatMap((node) => node.stellarAddresses))];
    const funders = await this.loadFunders(addresses);
    const globalFanout = await this.loadGlobalFanout(nodes, funders, addresses);

    const report: SybilLeagueReport = {
      leagueId,
      analyzedAt: new Date().toISOString(),
      memberCount: nodes.length,
      ...analyzeSybilGraph({ nodes, funders, globalFanout }, this.policy),
    };

    for (const account of report.accounts) {
      if (!account.flagged) continue;
      this.anomalyLog.record({
        type: SecurityAnomalyType.SYBIL_CLUSTER_SUSPECTED,
        userId: account.userId,
        identifier: leagueId,
        ip: "n/a",
        detail: { riskScore: account.riskScore, clusterId: account.clusterId },
      });
    }

    await this.cacheReport(cacheKey, report);
    return report;
  }

  private async loadNodes(leagueId: string): Promise<SybilAccountNode[]> {
    const since = new Date(Date.now() - this.policy.signalLookbackMs);
    const members: Array<{
      userId: string;
      stellarAddress: string | null;
      user: {
        username: string;
        wallet: { stellarAddress: string } | null;
        accountSignals: Array<{ type: "DEVICE" | "IP_SUBNET"; value: string }>;
      };
      squad: {
        createdAt: Date;
        players: Array<{ playerId: number }>;
        transfers: Array<{ gameweekId: number; playerInId: number; playerOutId: number; timestamp: Date }>;
      };
    }> = await this.db.leagueMember.findMany({
      where: { leagueId },
      select: {
        userId: true,
        stellarAddress: true,
        user: {
          select: {
            username: true,
            wallet: { select: { stellarAddress: true } },
            accountSignals: { where: { lastSeenAt: { gte: since } }, select: { type: true, value: true } },
          },
        },
        squad: {
          select: {
            createdAt: true,
            players: { select: { playerId: true } },
            transfers: { select: { gameweekId: true, playerInId: true, playerOutId: true, timestamp: true } },
          },
        },
      },
    });

    return members.map((member) => ({
      userId: member.userId,
      username: member.user.username,
      stellarAddresses: [
        ...new Set([member.user.wallet?.stellarAddress, member.stellarAddress].filter((a): a is string => Boolean(a))),
      ],
      squad: { createdAt: member.squad.createdAt, playerIds: member.squad.players.map((p) => p.playerId) },
      transfers: member.squad.transfers.map((t) => ({
        gameweekId: t.gameweekId,
        playerInId: t.playerInId,
        playerOutId: t.playerOutId,
        at: t.timestamp,
      })),
      signals: member.user.accountSignals,
    }));
  }

  /** Funders from the cache table; unknown addresses are resolved on Horizon once and stored. */
  private async loadFunders(addresses: string[]): Promise<Map<string, string>> {
    if (addresses.length === 0) return new Map();
    const known: Array<{ address: string; funder: string }> = await this.db.stellarAccountFunder.findMany({
      where: { address: { in: addresses } },
      select: { address: true, funder: true },
    });
    const funders = new Map(known.map((row) => [row.address, row.funder]));

    const unresolved = addresses.filter((address) => !funders.has(address));
    const resolved = await mapWithConcurrency(unresolved, HORIZON_CONCURRENCY, async (address) => ({
      address,
      funder: await this.resolveFunder(address).catch(() => null),
    }));
    const rows = resolved.filter((row): row is { address: string; funder: string } => row.funder !== null);
    if (rows.length > 0) {
      await this.db.stellarAccountFunder.createMany({ data: rows, skipDuplicates: true });
      for (const row of rows) funders.set(row.address, row.funder);
    }
    return funders;
  }

  /** Platform-wide account counts for the signals seen in this league (hub suppression). */
  private async loadGlobalFanout(
    nodes: SybilAccountNode[],
    funders: Map<string, string>,
    addresses: string[]
  ): Promise<Map<string, number>> {
    const fanout = new Map<string, number>();
    const devices = new Set<string>();
    const subnets = new Set<string>();
    for (const node of nodes) {
      for (const signal of node.signals) (signal.type === "DEVICE" ? devices : subnets).add(signal.value);
    }

    if (devices.size > 0 || subnets.size > 0) {
      const rows: Array<{ type: string; value: string; _count: { _all: number } }> =
        await this.db.accountSignal.groupBy({
          by: ["type", "value"],
          where: {
            OR: [
              { type: "DEVICE", value: { in: [...devices] } },
              { type: "IP_SUBNET", value: { in: [...subnets] } },
            ],
          },
          _count: { _all: true },
        });
      for (const row of rows) fanout.set(`${row.type}:${row.value}`, row._count._all);
    }

    const funderKeys = [...new Set([...funders.values(), ...addresses])];
    if (funderKeys.length > 0) {
      const rows: Array<{ funder: string; _count: { _all: number } }> = await this.db.stellarAccountFunder.groupBy({
        by: ["funder"],
        where: { funder: { in: funderKeys } },
        _count: { _all: true },
      });
      for (const row of rows) fanout.set(`FUNDER:${row.funder}`, row._count._all);
    }
    return fanout;
  }

  private async readCachedReport(key: string): Promise<SybilLeagueReport | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as SybilLeagueReport) : null;
    } catch (err) {
      console.warn(`[security] Redis GET error for ${key}:`, (err as Error).message);
      return null;
    }
  }

  private async cacheReport(key: string, report: SybilLeagueReport): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(report), "EX", this.reportTtlSeconds);
    } catch (err) {
      console.warn(`[security] Redis SET error for ${key}:`, (err as Error).message);
    }
  }
}

export const sybilDetectionGraphService = new SybilDetectionGraphService();
