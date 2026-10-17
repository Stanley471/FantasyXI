import { securityAnomalyLog, SecurityAnomalyType } from "./securityAnomalyLog.js";

export type SybilSignalType =
  | "SHARED_WALLET_FUNDER"
  | "SHARED_IP_SUBNET"
  | "SHARED_DEVICE_FINGERPRINT"
  | "COORDINATED_SQUAD_SUBMISSION";

export type SybilConfidenceRating = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface AccountActivityNode {
  userId: string;
  username?: string;
  stellarAddress?: string;
  funderStellarAddress?: string;
  ipAddresses?: string[];
  deviceFingerprints?: string[];
  squadSubmissions?: Array<{
    leagueId: string;
    playerIds: number[];
    captainId?: number;
    submittedAtMs: number;
  }>;
}

export interface SybilGraphEdge {
  sourceUserId: string;
  targetUserId: string;
  signals: SybilSignalType[];
  weight: number;
  evidence: Record<string, unknown>;
}

export interface UserSybilRiskProfile {
  userId: string;
  riskScore: number; // 0 - 100
  confidence: SybilConfidenceRating;
  flagged: boolean;
  signals: SybilSignalType[];
  connectedPeers: string[];
  clusterId: string;
}

export interface SybilSyndicateCluster {
  clusterId: string;
  memberUserIds: string[];
  maxRiskScore: number;
  averageRiskScore: number;
  confidence: SybilConfidenceRating;
  dominantSignals: SybilSignalType[];
  edges: SybilGraphEdge[];
}

export interface SybilGraphAnalysisReport {
  analyzedAt: string;
  totalAccountsAnalyzed: number;
  flaggedAccountsCount: number;
  clusters: SybilSyndicateCluster[];
  userProfiles: UserSybilRiskProfile[];
}

function extractIpv4Subnet24(ip: string): string | null {
  const trimmed = ip.trim();
  const parts = trimmed.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  return null;
}

function jaccardSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function scoreToConfidence(score: number): SybilConfidenceRating {
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "LOW";
}

/**
 * Constructs an account relationship graph and detects coordinated multi-account
 * Sybil syndicates across shared Stellar wallet funders, IP subnets, device
 * fingerprints, and collusive squad submissions.
 */
export class SybilDetectionGraphService {
  private latestReport: SybilGraphAnalysisReport | null = null;
  private readonly flagThreshold: number;
  private readonly squadOverlapThreshold: number;
  private readonly submissionSyncWindowMs: number;

  constructor(options?: {
    flagThreshold?: number;
    squadOverlapThreshold?: number;
    submissionSyncWindowMs?: number;
  }) {
    this.flagThreshold = options?.flagThreshold ?? 50;
    this.squadOverlapThreshold = options?.squadOverlapThreshold ?? 0.8;
    this.submissionSyncWindowMs = options?.submissionSyncWindowMs ?? 5 * 60 * 1000; // 5 minutes
  }

  public getLatestReport(): SybilGraphAnalysisReport | null {
    return this.latestReport;
  }

  public analyzeAccounts(accounts: AccountActivityNode[]): SybilGraphAnalysisReport {
    const edges: SybilGraphEdge[] = [];
    const adjacency = new Map<string, Set<string>>();
    const userSignals = new Map<string, Set<SybilSignalType>>();
    const userEdgeWeights = new Map<string, number>();

    for (const acc of accounts) {
      adjacency.set(acc.userId, new Set());
      userSignals.set(acc.userId, new Set());
      userEdgeWeights.set(acc.userId, 0);
    }

    for (let i = 0; i < accounts.length; i++) {
      for (let j = i + 1; j < accounts.length; j++) {
        const a = accounts[i];
        const b = accounts[j];
        const pairSignals: SybilSignalType[] = [];
        const evidence: Record<string, unknown> = {};
        let weight = 0;

        // 1. Shared Stellar funder address or shared deposit wallet
        if (
          (a.funderStellarAddress &&
            b.funderStellarAddress &&
            a.funderStellarAddress === b.funderStellarAddress) ||
          (a.stellarAddress &&
            b.funderStellarAddress &&
            a.stellarAddress === b.funderStellarAddress) ||
          (b.stellarAddress &&
            a.funderStellarAddress &&
            b.stellarAddress === a.funderStellarAddress)
        ) {
          pairSignals.push("SHARED_WALLET_FUNDER");
          weight += 45;
          evidence.sharedFunder = a.funderStellarAddress || b.funderStellarAddress;
        }

        // 2. Shared browser/device fingerprint
        const fpA = new Set(a.deviceFingerprints ?? []);
        const sharedFp = (b.deviceFingerprints ?? []).filter((fp) => fpA.has(fp));
        if (sharedFp.length > 0) {
          pairSignals.push("SHARED_DEVICE_FINGERPRINT");
          weight += 35;
          evidence.sharedFingerprints = sharedFp;
        }

        // 3. Shared IP /24 subnet or exact IP
        const subnetsA = new Set(
          (a.ipAddresses ?? []).map((ip) => extractIpv4Subnet24(ip) || ip)
        );
        const sharedSubnets = (b.ipAddresses ?? [])
          .map((ip) => extractIpv4Subnet24(ip) || ip)
          .filter((sub) => subnetsA.has(sub));
        if (sharedSubnets.length > 0) {
          pairSignals.push("SHARED_IP_SUBNET");
          weight += 25;
          evidence.sharedSubnets = [...new Set(sharedSubnets)];
        }

        // 4. Coordinated squad submissions in the same league
        const squadsA = a.squadSubmissions ?? [];
        const squadsB = b.squadSubmissions ?? [];
        for (const sqA of squadsA) {
          for (const sqB of squadsB) {
            if (sqA.leagueId !== sqB.leagueId) continue;
            const overlap = jaccardSimilarity(sqA.playerIds, sqB.playerIds);
            const timeDeltaMs = Math.abs(sqA.submittedAtMs - sqB.submittedAtMs);
            if (
              overlap >= this.squadOverlapThreshold &&
              timeDeltaMs <= this.submissionSyncWindowMs
            ) {
              if (!pairSignals.includes("COORDINATED_SQUAD_SUBMISSION")) {
                pairSignals.push("COORDINATED_SQUAD_SUBMISSION");
                weight += 40;
              }
              evidence.coordinatedSquad = {
                leagueId: sqA.leagueId,
                jaccardOverlap: Number(overlap.toFixed(3)),
                timeDeltaMs,
                sameCaptain:
                  sqA.captainId !== undefined && sqA.captainId === sqB.captainId,
              };
            }
          }
        }

        if (pairSignals.length > 0) {
          edges.push({
            sourceUserId: a.userId,
            targetUserId: b.userId,
            signals: pairSignals,
            weight,
            evidence,
          });
          adjacency.get(a.userId)!.add(b.userId);
          adjacency.get(b.userId)!.add(a.userId);
          for (const sig of pairSignals) {
            userSignals.get(a.userId)!.add(sig);
            userSignals.get(b.userId)!.add(sig);
          }
          userEdgeWeights.set(a.userId, (userEdgeWeights.get(a.userId) ?? 0) + weight);
          userEdgeWeights.set(b.userId, (userEdgeWeights.get(b.userId) ?? 0) + weight);
        }
      }
    }

    // Connected components via BFS
    const visited = new Set<string>();
    const userClusterMap = new Map<string, string>();
    const rawClusters: Array<{ clusterId: string; members: string[] }> = [];
    let clusterCounter = 1;

    for (const acc of accounts) {
      if (visited.has(acc.userId)) continue;
      const queue = [acc.userId];
      visited.add(acc.userId);
      const members: string[] = [];

      while (queue.length > 0) {
        const curr = queue.shift()!;
        members.push(curr);
        for (const neighbor of adjacency.get(curr) ?? []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      const clusterId = `cluster-${clusterCounter++}`;
      for (const m of members) {
        userClusterMap.set(m, clusterId);
      }
      rawClusters.push({ clusterId, members });
    }

    const userProfiles: UserSybilRiskProfile[] = accounts.map((acc) => {
      const peers = [...(adjacency.get(acc.userId) ?? [])];
      const signals = [...(userSignals.get(acc.userId) ?? [])];
      const rawWeight = userEdgeWeights.get(acc.userId) ?? 0;
      const clusterSizeBonus = peers.length >= 2 ? Math.min(20, (peers.length - 1) * 10) : 0;
      const riskScore = Math.min(100, rawWeight + clusterSizeBonus);
      const confidence = scoreToConfidence(riskScore);
      const flagged = riskScore >= this.flagThreshold;

      return {
        userId: acc.userId,
        riskScore,
        confidence,
        flagged,
        signals,
        connectedPeers: peers,
        clusterId: userClusterMap.get(acc.userId) ?? "cluster-0",
      };
    });

    const profileById = new Map(userProfiles.map((p) => [p.userId, p]));

    const clusters: SybilSyndicateCluster[] = rawClusters
      .filter((c) => c.members.length > 1)
      .map((c) => {
        const memberProfiles = c.members.map((id) => profileById.get(id)!);
        const maxRiskScore = Math.max(...memberProfiles.map((p) => p.riskScore));
        const avgRisk =
          memberProfiles.reduce((sum, p) => sum + p.riskScore, 0) / memberProfiles.length;
        const clusterSignals = new Set<SybilSignalType>();
        for (const p of memberProfiles) {
          for (const s of p.signals) clusterSignals.add(s);
        }
        const memberSet = new Set(c.members);
        const clusterEdges = edges.filter(
          (e) => memberSet.has(e.sourceUserId) && memberSet.has(e.targetUserId)
        );

        const clusterObj: SybilSyndicateCluster = {
          clusterId: c.clusterId,
          memberUserIds: c.members,
          maxRiskScore,
          averageRiskScore: Number(avgRisk.toFixed(2)),
          confidence: scoreToConfidence(maxRiskScore),
          dominantSignals: [...clusterSignals],
          edges: clusterEdges,
        };

        if (maxRiskScore >= this.flagThreshold) {
          securityAnomalyLog.record({
            type: SecurityAnomalyType.SYBIL_SYNDICATE_DETECTED,
            userId: c.members[0],
            identifier: c.clusterId,
            ip: "0.0.0.0",
            detail: {
              clusterId: c.clusterId,
              memberUserIds: c.members,
              maxRiskScore,
              confidence: clusterObj.confidence,
              dominantSignals: clusterObj.dominantSignals,
            },
          });
        }

        return clusterObj;
      })
      .sort((a, b) => b.maxRiskScore - a.maxRiskScore);

    const report: SybilGraphAnalysisReport = {
      analyzedAt: new Date().toISOString(),
      totalAccountsAnalyzed: accounts.length,
      flaggedAccountsCount: userProfiles.filter((p) => p.flagged).length,
      clusters,
      userProfiles,
    };

    this.latestReport = report;
    return report;
  }
}

export const sybilDetectionGraphService = new SybilDetectionGraphService();
