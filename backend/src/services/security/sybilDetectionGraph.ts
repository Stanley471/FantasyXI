import { isIP } from "node:net";

/**
 * Sybil / collusion syndicate detection graph (issue #274).
 *
 * Accounts are nodes; an edge links two accounts that share evidence of
 * common control. Evidence comes in independent families, and within a
 * family only the strongest signal counts (an exact shared IP already implies
 * the shared subnet, so counting both would double-count one fact):
 *
 *   funding  FUNDING_LINEAGE   one account's wallet created the other's (0.95)
 *            SHARED_FUNDER     both wallets were created by the same funder (0.9)
 *   device   SHARED_FINGERPRINT same client-supplied browser fingerprint (0.85)
 *   network  SHARED_LOGIN_SIGNATURE same IP + user agent pair (0.75)
 *            SHARED_IP         same IP address (0.5)
 *            SHARED_SUBNET     same IPv4 /24 or IPv6 /48 (0.25)
 *   squads   COORDINATED_SQUAD near-identical squads entered in the same
 *            league within minutes of each other (overlap x time proximity)
 *
 * An edge's confidence is the noisy-OR of its family scores,
 * 1 - prod(1 - w). Attributes shared by very many accounts (an exchange's
 * hot wallet, a university NAT) are "hubs": their weight is damped, and
 * beyond a hard fan-out cap they are ignored, so common infrastructure does
 * not glue unrelated users into one giant cluster.
 *
 * Accounts joined by edges at or above `edgeThreshold` form clusters
 * (connected components). An account's risk is the noisy-OR of its
 * cluster-strength edges, or its single strongest edge if that is higher:
 * many weak links (e.g. everyone behind one carrier NAT) never add up to a
 * flag on their own. Accounts at or above `flagThreshold` are flagged for
 * manual review.
 * Nothing here takes automated action against an account.
 */

export enum SybilSignalType {
  FUNDING_LINEAGE = "FUNDING_LINEAGE",
  SHARED_FUNDER = "SHARED_FUNDER",
  SHARED_FINGERPRINT = "SHARED_FINGERPRINT",
  SHARED_LOGIN_SIGNATURE = "SHARED_LOGIN_SIGNATURE",
  SHARED_IP = "SHARED_IP",
  SHARED_SUBNET = "SHARED_SUBNET",
  COORDINATED_SQUAD = "COORDINATED_SQUAD",
}

type SignalFamily = "funding" | "device" | "network" | "squads";

const SIGNAL_FAMILY: Record<SybilSignalType, SignalFamily> = {
  [SybilSignalType.FUNDING_LINEAGE]: "funding",
  [SybilSignalType.SHARED_FUNDER]: "funding",
  [SybilSignalType.SHARED_FINGERPRINT]: "device",
  [SybilSignalType.SHARED_LOGIN_SIGNATURE]: "network",
  [SybilSignalType.SHARED_IP]: "network",
  [SybilSignalType.SHARED_SUBNET]: "network",
  [SybilSignalType.COORDINATED_SQUAD]: "squads",
};

export interface LoginSignal {
  ip: string;
  userAgent?: string | null;
  /** Client-supplied browser fingerprint hash, when available. */
  fingerprint?: string | null;
}

export interface SquadSubmissionSignal {
  squadId: string;
  leagueIds: string[];
  playerIds: number[];
  submittedAt: Date;
}

export interface AccountSignals {
  userId: string;
  username?: string | null;
  /** Stellar addresses this account controls (connected wallet, payout addresses). */
  walletAddresses?: string[];
  /** Addresses that created/funded this account's wallets. */
  funderAddresses?: string[];
  logins?: LoginSignal[];
  squadSubmissions?: SquadSubmissionSignal[];
}

export interface SignalEvidence {
  type: SybilSignalType;
  weight: number;
  detail: string;
}

export interface SybilGraphEdge {
  source: string;
  target: string;
  confidence: number;
  signals: SignalEvidence[];
}

export type ConfidenceRating = "HIGH" | "MEDIUM" | "LOW";

export interface SybilCluster {
  clusterId: string;
  members: string[];
  size: number;
  riskScore: number;
  confidence: ConfidenceRating;
  signalCounts: Partial<Record<SybilSignalType, number>>;
  edges: SybilGraphEdge[];
}

export interface CollusionPattern {
  leagueId: string;
  users: [string, string];
  squads: [string, string];
  overlap: number;
  secondsApart: number;
  confidence: number;
  rating: ConfidenceRating;
}

export interface UserRiskAssessment {
  userId: string;
  username: string | null;
  riskScore: number;
  rating: ConfidenceRating;
  clusterId: string | null;
  signals: SybilSignalType[];
  connections: number;
}

export interface SybilGraphReport {
  generatedAt: string;
  accountsAnalyzed: number;
  edgeCount: number;
  clusters: SybilCluster[];
  flaggedUsers: UserRiskAssessment[];
  collusionPatterns: CollusionPattern[];
  thresholds: { edgeThreshold: number; flagThreshold: number };
}

export interface SybilGraphOptions {
  weights: Record<SybilSignalType, number>;
  /** Accounts sharing one attribute beyond this count are damped as a hub. */
  hubThreshold: number;
  /** Weight multiplier for hub attributes. */
  hubDamping: number;
  /** Attributes shared by more accounts than this are ignored entirely. */
  maxAttributeFanout: number;
  /** Minimum Jaccard overlap of two squads' players to count as coordinated. */
  squadOverlapThreshold: number;
  /** Maximum gap between two coordinated squad submissions. */
  squadWindowMs: number;
  /** Minimum edge confidence that joins two accounts into one cluster. */
  edgeThreshold: number;
  /** Minimum account risk that flags the account for review. */
  flagThreshold: number;
  now?: () => Date;
}

export const DEFAULT_SYBIL_GRAPH_OPTIONS: SybilGraphOptions = {
  weights: {
    [SybilSignalType.FUNDING_LINEAGE]: 0.95,
    [SybilSignalType.SHARED_FUNDER]: 0.9,
    [SybilSignalType.SHARED_FINGERPRINT]: 0.85,
    [SybilSignalType.SHARED_LOGIN_SIGNATURE]: 0.75,
    [SybilSignalType.SHARED_IP]: 0.5,
    [SybilSignalType.SHARED_SUBNET]: 0.25,
    [SybilSignalType.COORDINATED_SQUAD]: 0.8,
  },
  hubThreshold: 10,
  hubDamping: 0.25,
  maxAttributeFanout: 200,
  squadOverlapThreshold: 0.8,
  squadWindowMs: 15 * 60 * 1000,
  edgeThreshold: 0.5,
  flagThreshold: 0.7,
};

const round = (value: number) => Math.round(value * 1000) / 1000;

export function rateConfidence(score: number): ConfidenceRating {
  if (score >= 0.85) return "HIGH";
  if (score >= 0.6) return "MEDIUM";
  return "LOW";
}

/** IPv4 /24 or IPv6 /48 prefix, or null for unparseable addresses. */
export function subnetOf(ip: string): string | null {
  const address = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const version = isIP(address);
  if (version === 4) {
    return `${address.split(".").slice(0, 3).join(".")}.0/24`;
  }
  if (version === 6) {
    const [head] = address.split("::");
    const groups = head.split(":").filter(Boolean);
    while (groups.length < 3) groups.push("0");
    return `${groups.slice(0, 3).join(":")}::/48`;
  }
  return null;
}

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function jaccard(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  let shared = 0;
  const setB = new Set(b);
  for (const id of setB) if (setA.has(id)) shared++;
  return shared / (setA.size + setB.size - shared);
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root !== x) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

/** Collects evidence per account pair, keeping the strongest signal per family. */
class EvidenceGraph {
  private readonly pairs = new Map<string, Map<SignalFamily, SignalEvidence>>();

  private key(a: string, b: string): string {
    return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  }

  add(a: string, b: string, evidence: SignalEvidence): void {
    if (a === b || evidence.weight <= 0) return;
    const key = this.key(a, b);
    const families = this.pairs.get(key) ?? new Map<SignalFamily, SignalEvidence>();
    const family = SIGNAL_FAMILY[evidence.type];
    const existing = families.get(family);
    if (!existing || evidence.weight > existing.weight) families.set(family, evidence);
    this.pairs.set(key, families);
  }

  edges(): SybilGraphEdge[] {
    const edges: SybilGraphEdge[] = [];
    for (const [key, families] of this.pairs) {
      const [source, target] = key.split("\u0000");
      const signals = [...families.values()].sort((x, y) => y.weight - x.weight);
      const confidence = 1 - signals.reduce((acc, s) => acc * (1 - s.weight), 1);
      edges.push({
        source,
        target,
        confidence: round(confidence),
        signals: signals.map((s) => ({ ...s, weight: round(s.weight) })),
      });
    }
    return edges.sort((x, y) => y.confidence - x.confidence);
  }
}

/**
 * Builds the account relationship graph and scores it. Pure and
 * deterministic for a given input (apart from `generatedAt`).
 */
export function analyzeSybilGraph(
  accounts: AccountSignals[],
  overrides: Partial<SybilGraphOptions> = {}
): SybilGraphReport {
  const options: SybilGraphOptions = {
    ...DEFAULT_SYBIL_GRAPH_OPTIONS,
    ...overrides,
    weights: { ...DEFAULT_SYBIL_GRAPH_OPTIONS.weights, ...overrides.weights },
  };
  const graph = new EvidenceGraph();

  // --- Shared attributes (funders, fingerprints, login signatures, IPs, subnets)
  const attributes = new Map<string, { type: SybilSignalType; detail: string; users: Set<string> }>();
  const addAttribute = (type: SybilSignalType, value: string, detail: string, userId: string) => {
    const key = `${type}:${value}`;
    const entry = attributes.get(key) ?? { type, detail, users: new Set<string>() };
    entry.users.add(userId);
    attributes.set(key, entry);
  };

  const walletOwner = new Map<string, string>();
  for (const account of accounts) {
    for (const address of account.walletAddresses ?? []) walletOwner.set(address, account.userId);
  }

  for (const account of accounts) {
    for (const funder of new Set(account.funderAddresses ?? [])) {
      const owner = walletOwner.get(funder);
      if (owner && owner !== account.userId) {
        graph.add(owner, account.userId, {
          type: SybilSignalType.FUNDING_LINEAGE,
          weight: options.weights.FUNDING_LINEAGE,
          detail: `wallet ${funder} funded this account's wallet`,
        });
      }
      addAttribute(SybilSignalType.SHARED_FUNDER, funder, `common funder ${funder}`, account.userId);
    }

    for (const login of account.logins ?? []) {
      const ip = normalizeIp(login.ip);
      if (login.fingerprint) {
        addAttribute(SybilSignalType.SHARED_FINGERPRINT, login.fingerprint, `fingerprint ${login.fingerprint}`, account.userId);
      }
      const userAgent = login.userAgent?.trim();
      if (userAgent && userAgent !== "unknown") {
        addAttribute(SybilSignalType.SHARED_LOGIN_SIGNATURE, `${ip}|${userAgent}`, `login signature ${ip} / ${userAgent}`, account.userId);
      }
      addAttribute(SybilSignalType.SHARED_IP, ip, `IP ${ip}`, account.userId);
      const subnet = subnetOf(ip);
      if (subnet) addAttribute(SybilSignalType.SHARED_SUBNET, subnet, `subnet ${subnet}`, account.userId);
    }
  }

  for (const { type, detail, users } of attributes.values()) {
    if (users.size < 2 || users.size > options.maxAttributeFanout) continue;
    const isHub = users.size > options.hubThreshold;
    const weight = options.weights[type] * (isHub ? options.hubDamping : 1);
    const label = isHub ? `${detail} (shared by ${users.size} accounts)` : detail;
    const members = [...users];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        graph.add(members[i], members[j], { type, weight, detail: label });
      }
    }
  }

  // --- Coordinated squad submissions within each league
  const collusionPatterns: CollusionPattern[] = [];
  const byLeague = new Map<string, Array<{ userId: string; submission: SquadSubmissionSignal }>>();
  for (const account of accounts) {
    for (const submission of account.squadSubmissions ?? []) {
      for (const leagueId of submission.leagueIds) {
        const list = byLeague.get(leagueId) ?? [];
        list.push({ userId: account.userId, submission });
        byLeague.set(leagueId, list);
      }
    }
  }
  for (const [leagueId, entries] of byLeague) {
    entries.sort((a, b) => a.submission.submittedAt.getTime() - b.submission.submittedAt.getTime());
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j];
        const gapMs = b.submission.submittedAt.getTime() - a.submission.submittedAt.getTime();
        if (gapMs > options.squadWindowMs) break;
        if (a.userId === b.userId) continue;
        const overlap = jaccard(a.submission.playerIds, b.submission.playerIds);
        if (overlap < options.squadOverlapThreshold) continue;
        const proximity = 1 - 0.5 * (gapMs / options.squadWindowMs);
        const confidence = options.weights.COORDINATED_SQUAD * overlap * proximity;
        const secondsApart = Math.round(gapMs / 1000);
        graph.add(a.userId, b.userId, {
          type: SybilSignalType.COORDINATED_SQUAD,
          weight: confidence,
          detail: `${Math.round(overlap * 100)}% identical squads in league ${leagueId}, ${secondsApart}s apart`,
        });
        collusionPatterns.push({
          leagueId,
          users: [a.userId, b.userId],
          squads: [a.submission.squadId, b.submission.squadId],
          overlap: round(overlap),
          secondsApart,
          confidence: round(confidence),
          rating: rateConfidence(confidence),
        });
      }
    }
  }

  // --- Clusters, risk scores and flags
  const edges = graph.edges();
  const unionFind = new UnionFind();
  const incident = new Map<string, SybilGraphEdge[]>();
  for (const edge of edges) {
    for (const node of [edge.source, edge.target]) {
      const list = incident.get(node) ?? [];
      list.push(edge);
      incident.set(node, list);
    }
    if (edge.confidence >= options.edgeThreshold) unionFind.union(edge.source, edge.target);
  }

  const usernames = new Map(accounts.map((a) => [a.userId, a.username ?? null]));
  const riskOf = new Map<string, number>();
  for (const [userId, list] of incident) {
    const strongest = Math.max(...list.map((e) => e.confidence));
    const strong = list.filter((e) => e.confidence >= options.edgeThreshold);
    const combined = 1 - strong.reduce((acc, e) => acc * (1 - e.confidence), 1);
    riskOf.set(userId, round(Math.max(strongest, combined)));
  }

  const clusterMembers = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.confidence < options.edgeThreshold) continue;
    for (const node of [edge.source, edge.target]) {
      const root = unionFind.find(node);
      const members = clusterMembers.get(root) ?? new Set<string>();
      members.add(node);
      clusterMembers.set(root, members);
    }
  }

  const clusterIdOf = new Map<string, string>();
  const clusters: SybilCluster[] = [];
  for (const memberSet of clusterMembers.values()) {
    const members = [...memberSet].sort();
    const clusterId = `cluster-${members[0]}`;
    const clusterEdges = edges.filter(
      (e) => memberSet.has(e.source) && memberSet.has(e.target) && e.confidence >= options.edgeThreshold
    );
    const signalCounts: Partial<Record<SybilSignalType, number>> = {};
    for (const edge of clusterEdges) {
      for (const signal of edge.signals) signalCounts[signal.type] = (signalCounts[signal.type] ?? 0) + 1;
    }
    const riskScore = round(members.reduce((sum, m) => sum + (riskOf.get(m) ?? 0), 0) / members.length);
    for (const member of members) clusterIdOf.set(member, clusterId);
    clusters.push({
      clusterId,
      members,
      size: members.length,
      riskScore,
      confidence: rateConfidence(riskScore),
      signalCounts,
      edges: clusterEdges,
    });
  }
  clusters.sort((a, b) => b.riskScore - a.riskScore || b.size - a.size);

  const flaggedUsers: UserRiskAssessment[] = [];
  for (const [userId, riskScore] of riskOf) {
    if (riskScore < options.flagThreshold) continue;
    const list = incident.get(userId) ?? [];
    flaggedUsers.push({
      userId,
      username: usernames.get(userId) ?? null,
      riskScore,
      rating: rateConfidence(riskScore),
      clusterId: clusterIdOf.get(userId) ?? null,
      signals: [...new Set(list.flatMap((e) => e.signals.map((s) => s.type)))],
      connections: list.length,
    });
  }
  flaggedUsers.sort((a, b) => b.riskScore - a.riskScore || a.userId.localeCompare(b.userId));
  collusionPatterns.sort((a, b) => b.confidence - a.confidence);

  return {
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    accountsAnalyzed: accounts.length,
    edgeCount: edges.length,
    clusters,
    flaggedUsers,
    collusionPatterns,
    thresholds: { edgeThreshold: options.edgeThreshold, flagThreshold: options.flagThreshold },
  };
}
