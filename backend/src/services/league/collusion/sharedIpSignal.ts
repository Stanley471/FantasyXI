/**
 * Configuration for shared IP signal detection.
 * Controls network commonality heuristics and scoring weights.
 */
export interface SharedIpConfig {
  /** Number of accounts on same subnet to consider it "common" (e.g., university, office) */
  commonNetworkThreshold: number;
  /** Weight discount for common networks (e.g., 0.3 = 30% of signal strength) */
  commonNetworkWeight: number;
  /** Minimum accounts to form a shared IP signal */
  minAccountsForFlag: number;
  /** Maximum score for IP-only evidence to prevent false flags */
  maxScoreIpOnly: number;
}

/**
 * Default configuration for shared IP detection.
 */
export const DEFAULT_SHARED_IP_CONFIG: SharedIpConfig = {
  commonNetworkThreshold: 10,
  commonNetworkWeight: 0.3,
  minAccountsForFlag: 2,
  maxScoreIpOnly: 0.4,
};

/**
 * Represents a shared IP subnet between two accounts.
 */
export interface IpSubnetOverlap {
  subnet: string; // CIDR notation, e.g., "192.168.1.0/24" or "2001:db8::/64"
  accountAFirstSeenAt: Date;
  accountALastSeenAt: Date;
  accountBFirstSeenAt: Date;
  accountBLastSeenAt: Date;
  isCommonNetwork: boolean; // True if >threshold accounts on this subnet
  weight: number; // 1.0 for rare overlap, 0.3 for common network
}

/**
 * Evidence structure for shared IP signal.
 */
export interface SharedIpEvidence {
  score: number;
  overlappingSubnets: IpSubnetOverlap[];
  totalAccountsOnCommonSubnets: number;
  config: SharedIpConfig;
  notes?: string;
}

/**
 * Represents a login signal (IP subnet) for an account.
 */
interface AccountSignal {
  type: 'IP_SUBNET' | 'DEVICE';
  value: string;
  userId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * Compute the commonality of an IP subnet across the league.
 * Returns true if more than threshold accounts use it.
 *
 * @param subnet IP subnet in CIDR notation
 * @param allAccountSignals All IP signals for all accounts in the league
 * @param threshold Number of accounts to consider "common"
 * @returns {isCommon, accountCount}
 */
function isCommonNetwork(
  subnet: string,
  allAccountSignals: AccountSignal[],
  threshold: number
): { isCommon: boolean; accountCount: number } {
  const accountsOnSubnet = new Set(
    allAccountSignals
      .filter((s) => s.type === 'IP_SUBNET' && s.value === subnet)
      .map((s) => s.userId)
  );

  return {
    isCommon: accountsOnSubnet.size > threshold,
    accountCount: accountsOnSubnet.size,
  };
}

/**
 * Compute shared IP signal between two accounts.
 * Detects overlapping IP subnets and weights by commonality.
 *
 * @param accountASignals IP signals for account A
 * @param accountBSignals IP signals for account B
 * @param allLeagueSignals All IP signals in the league (for commonality check)
 * @param config Signal configuration
 * @returns {score, evidence} tuple
 */
export function computeSharedIpScore(
  accountASignals: AccountSignal[],
  accountBSignals: AccountSignal[],
  allLeagueSignals: AccountSignal[],
  config: SharedIpConfig = DEFAULT_SHARED_IP_CONFIG
): { score: number; evidence: SharedIpEvidence } {
  // Extract IP subnets only
  const subnetsA = new Map(
    accountASignals
      .filter((s) => s.type === 'IP_SUBNET')
      .map((s) => [s.value, { firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt }])
  );

  const subnetsB = new Map(
    accountBSignals
      .filter((s) => s.type === 'IP_SUBNET')
      .map((s) => [s.value, { firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt }])
  );

  // Find overlapping subnets
  const overlaps: IpSubnetOverlap[] = [];
  let totalCommonAccountCount = 0;

  for (const [subnet, signalA] of subnetsA.entries()) {
    if (!subnetsB.has(subnet)) continue;

    const signalB = subnetsB.get(subnet)!;
    const { isCommon, accountCount } = isCommonNetwork(subnet, allLeagueSignals, config.commonNetworkThreshold);

    const weight = isCommon ? config.commonNetworkWeight : 1.0;

    overlaps.push({
      subnet,
      accountAFirstSeenAt: signalA.firstSeenAt,
      accountALastSeenAt: signalA.lastSeenAt,
      accountBFirstSeenAt: signalB.firstSeenAt,
      accountBLastSeenAt: signalB.lastSeenAt,
      isCommonNetwork: isCommon,
      weight,
    });

    if (isCommon) {
      totalCommonAccountCount = Math.max(totalCommonAccountCount, accountCount);
    }
  }

  // Compute score
  let score = 0;
  if (overlaps.length > 0) {
    // Score based on number of overlaps and their weights
    // Multiple overlaps on different subnets = higher suspicion
    // Common networks = lower weight
    const weightedOverlaps = overlaps.reduce((sum, overlap) => sum + overlap.weight, 0);
    score = Math.min(1.0, weightedOverlaps / overlaps.length);

    // Cap to maxScoreIpOnly to prevent IP-only flags
    score = Math.min(score, config.maxScoreIpOnly);
  }

  const evidence: SharedIpEvidence = {
    score,
    overlappingSubnets: overlaps,
    totalAccountsOnCommonSubnets: totalCommonAccountCount,
    config,
    notes:
      overlaps.length > 0 && overlaps[0].isCommonNetwork
        ? `Overlapping subnets are common networks (>${config.commonNetworkThreshold} accounts). Score discounted.`
        : undefined,
  };

  return { score, evidence };
}

/**
 * Compute shared IP signal in batch for multiple account pairs.
 * Reuses commonality calculations across all pairs for efficiency.
 *
 * @param pairs Account signal pairs to compare
 * @param allLeagueSignals All signals in the league
 * @param config Signal configuration
 * @returns Array of {score, evidence} tuples
 */
export function computeSharedIpScoreBatch(
  pairs: Array<{
    accountAId: string;
    signalsA: AccountSignal[];
    accountBId: string;
    signalsB: AccountSignal[];
  }>,
  allLeagueSignals: AccountSignal[],
  config: SharedIpConfig = DEFAULT_SHARED_IP_CONFIG
): Array<{ score: number; evidence: SharedIpEvidence }> {
  // Pre-compute subnet to account mapping for efficiency
  const subnetToAccounts = new Map<string, Set<string>>();

  for (const signal of allLeagueSignals) {
    if (signal.type === 'IP_SUBNET') {
      if (!subnetToAccounts.has(signal.value)) {
        subnetToAccounts.set(signal.value, new Set());
      }
      subnetToAccounts.get(signal.value)!.add(signal.userId);
    }
  }

  // Compute commonality once
  const subnetCommonality = new Map<string, boolean>();
  for (const [subnet, accounts] of subnetToAccounts.entries()) {
    subnetCommonality.set(subnet, accounts.size > config.commonNetworkThreshold);
  }

  return pairs.map(({ signalsA, signalsB }) => {
    const subnetsA = new Map(
      signalsA
        .filter((s) => s.type === 'IP_SUBNET')
        .map((s) => [s.value, { firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt }])
    );

    const subnetsB = new Map(
      signalsB
        .filter((s) => s.type === 'IP_SUBNET')
        .map((s) => [s.value, { firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt }])
    );

    const overlaps: IpSubnetOverlap[] = [];
    let totalCommonAccountCount = 0;

    for (const [subnet, signalA] of subnetsA.entries()) {
      if (!subnetsB.has(subnet)) continue;

      const signalB = subnetsB.get(subnet)!;
      const isCommon = subnetCommonality.get(subnet) ?? false;
      const accountCount = subnetToAccounts.get(subnet)?.size ?? 0;
      const weight = isCommon ? config.commonNetworkWeight : 1.0;

      overlaps.push({
        subnet,
        accountAFirstSeenAt: signalA.firstSeenAt,
        accountALastSeenAt: signalA.lastSeenAt,
        accountBFirstSeenAt: signalB.firstSeenAt,
        accountBLastSeenAt: signalB.lastSeenAt,
        isCommonNetwork: isCommon,
        weight,
      });

      if (isCommon) {
        totalCommonAccountCount = Math.max(totalCommonAccountCount, accountCount);
      }
    }

    let score = 0;
    if (overlaps.length > 0) {
      const weightedOverlaps = overlaps.reduce((sum, overlap) => sum + overlap.weight, 0);
      score = Math.min(1.0, weightedOverlaps / overlaps.length);
      score = Math.min(score, config.maxScoreIpOnly);
    }

    const evidence: SharedIpEvidence = {
      score,
      overlappingSubnets: overlaps,
      totalAccountsOnCommonSubnets: totalCommonAccountCount,
      config,
      notes:
        overlaps.length > 0 && overlaps[0].isCommonNetwork
          ? `Overlapping subnets are common networks (>${config.commonNetworkThreshold} accounts). Score discounted.`
          : undefined,
    };

    return { score, evidence };
  });
}
