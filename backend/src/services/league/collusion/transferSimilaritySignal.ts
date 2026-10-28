import { SquadTransfer, Player } from '@prisma/client';

/**
 * Configuration for transfer similarity signal detection.
 * Controls rarity weighting, time windows, and detection thresholds.
 */
export interface TransferSimilarityConfig {
  /** Minimum similarity score (0-1) to trigger the signal */
  minSimilarity: number;
  /** Time window in minutes within which transfers are considered coordinated */
  timeWindowMinutes: number;
  /** Minimum number of transfers in a sequence to compare */
  minTransfersInSequence: number;
  /** Maximum gameweek lag between transfers (ignore if far apart) */
  maxGameweekLag: number;
}

/**
 * Default configuration for transfer similarity detection.
 */
export const DEFAULT_TRANSFER_SIMILARITY_CONFIG: TransferSimilarityConfig = {
  minSimilarity: 0.7,
  timeWindowMinutes: 30,
  minTransfersInSequence: 2,
  maxGameweekLag: 1,
};

/**
 * A transfer normalized to (playerInFplId, playerOutFplId) for comparison.
 * Stored in a hashable format for rarity calculation.
 */
interface NormalizedTransfer {
  gameweekId: number;
  playerInFplId: number;
  playerOutFplId: number;
  timestamp: Date;
  inPrice: number;
  outPrice: number;
}

/**
 * Transfer pair hashed by (in, out) for rarity calculation.
 */
type TransferHash = string;

function hashTransfer(playerInFplId: number, playerOutFplId: number): TransferHash {
  // Canonical form: smaller ID first to treat symmetric transfers as identical
  const sorted = [playerInFplId, playerOutFplId].sort((a, b) => a - b);
  return `${sorted[0]}:${sorted[1]}`;
}

/**
 * Compute rarity of each transfer across the league.
 * Rarity = 1 / (1 + count of accounts making that exact transfer in same GW)
 * - A meta transfer (80% of league) → rarity ≈ 0.01
 * - A rare transfer (1 account) → rarity ≈ 0.5
 *
 * @param allLeagueTransfers All transfers in the league, enriched with player FPL IDs
 * @param gameweekRange Gameweek range to analyze
 * @returns Map of transfer hash to rarity score (0-1)
 */
function computeTransferRarityWeights(
  allLeagueTransfers: Array<NormalizedTransfer & { squadId: string }>,
  gameweekRange: { startGW: number; endGW: number }
): Map<TransferHash, number> {
  const rarityMap = new Map<TransferHash, number>();

  // Count how many accounts made each transfer in each gameweek
  const transferCounts = new Map<string, number>(); // key: `${gw}:${hash}`

  for (const transfer of allLeagueTransfers) {
    if (transfer.gameweekId < gameweekRange.startGW || transfer.gameweekId > gameweekRange.endGW) {
      continue;
    }

    const hash = hashTransfer(transfer.playerInFplId, transfer.playerOutFplId);
    const countKey = `${transfer.gameweekId}:${hash}`;
    transferCounts.set(countKey, (transferCounts.get(countKey) ?? 0) + 1);
  }

  // Convert counts to rarity scores
  // Rarity = 1 / (1 + count)
  // 1 account: 1/(1+1) = 0.5
  // 2 accounts: 1/(1+2) = 0.33
  // 80 accounts: 1/(1+80) = 0.012
  for (const [countKey, count] of transferCounts.entries()) {
    const hash = countKey.split(':').slice(1).join(':'); // extract hash
    const rarity = 1 / (1 + count);
    rarityMap.set(hash, rarity);
  }

  return rarityMap;
}

/**
 * Normalize transfers to extract FPL player IDs and enrich with timestamp.
 */
function normalizeTransfers(
  transfers: (SquadTransfer & { playerIn: Player; playerOut: Player })[],
  startGW: number,
  endGW: number
): NormalizedTransfer[] {
  return transfers
    .filter((t) => t.gameweekId >= startGW && t.gameweekId <= endGW)
    .map((t) => ({
      gameweekId: t.gameweekId,
      playerInFplId: t.playerIn.fplId,
      playerOutFplId: t.playerOut.fplId,
      timestamp: t.timestamp,
      inPrice: Number(t.inPrice),
      outPrice: Number(t.outPrice),
    }));
}

/**
 * Extract transfer sequences within a time window, grouped by gameweek.
 * A sequence is a set of transfers made within timeWindowMinutes.
 */
function extractTransferSequences(
  transfers: NormalizedTransfer[],
  timeWindowMinutes: number
): NormalizedTransfer[][] {
  if (transfers.length === 0) return [];

  // Sort by timestamp
  const sorted = [...transfers].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const sequences: NormalizedTransfer[][] = [];
  let currentSequence: NormalizedTransfer[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const timeDiff =
      (sorted[i].timestamp.getTime() - currentSequence[0].timestamp.getTime()) / (1000 * 60);

    if (timeDiff <= timeWindowMinutes) {
      currentSequence.push(sorted[i]);
    } else {
      if (currentSequence.length > 0) {
        sequences.push([...currentSequence]);
      }
      currentSequence = [sorted[i]];
    }
  }

  if (currentSequence.length > 0) {
    sequences.push(currentSequence);
  }

  return sequences;
}

/**
 * Compare two transfer sequences and compute similarity based on rarity-weighted overlap.
 * Returns a score from 0 to 1.
 */
function compareSequences(
  seqA: NormalizedTransfer[],
  seqB: NormalizedTransfer[],
  rarityWeights: Map<TransferHash, number>,
  maxGameweekLag: number
): number {
  if (seqA.length === 0 || seqB.length === 0) return 0;

  // Check gameweek proximity
  const gwA = seqA[0].gameweekId;
  const gwB = seqB[0].gameweekId;
  if (Math.abs(gwA - gwB) > maxGameweekLag) return 0;

  // Build hashes for each sequence
  const hashesA = new Set(seqA.map((t) => hashTransfer(t.playerInFplId, t.playerOutFplId)));
  const hashesB = new Set(seqB.map((t) => hashTransfer(t.playerInFplId, t.playerOutFplId)));

  // Find intersection
  const intersection = Array.from(hashesA).filter((h) => hashesB.has(h));

  if (intersection.length === 0) return 0;

  // Sum rarity weights for matching transfers
  let matchWeight = 0;
  for (const hash of intersection) {
    matchWeight += rarityWeights.get(hash) ?? 0;
  }

  // Normalize by max sequence length to get 0-1 score
  const maxLength = Math.max(seqA.length, seqB.length);
  const weightedSimilarity = matchWeight / maxLength;

  return Math.min(1.0, weightedSimilarity);
}

/**
 * Evidence structure for transfer similarity signal.
 */
export interface TransferSimilarityEvidence {
  score: number;
  pairwiseComparisons: Array<{
    sequenceIndexA: number;
    sequenceIndexB: number;
    similarity: number;
    matchedTransfers: Array<{
      playerInFplId: number;
      playerOutFplId: number;
      rarity: number;
    }>;
  }>;
  overallScore: number;
  gameweekRange: { startGW: number; endGW: number };
  config: TransferSimilarityConfig;
  sequencesCountA: number;
  sequencesCountB: number;
}

/**
 * Compute transfer similarity signal between two accounts.
 * Analyzes transfer sequences and weights by rarity.
 *
 * @param transfersA All transfers for squad A (with player relations)
 * @param transfersB All transfers for squad B (with player relations)
 * @param allLeagueTransfers All transfers in the league (for rarity calculation)
 * @param gameweekRange Gameweek range to analyze
 * @param config Signal configuration
 * @returns {score, evidence} tuple
 */
export function computeTransferSimilarity(
  transfersA: (SquadTransfer & { playerIn: Player; playerOut: Player })[],
  transfersB: (SquadTransfer & { playerIn: Player; playerOut: Player })[],
  allLeagueTransfers: Array<SquadTransfer & { playerIn: Player; playerOut: Player }>,
  gameweekRange: { startGW: number; endGW: number },
  config: TransferSimilarityConfig = DEFAULT_TRANSFER_SIMILARITY_CONFIG
): { score: number; evidence: TransferSimilarityEvidence } {
  // Normalize transfers
  const normA = normalizeTransfers(transfersA, gameweekRange.startGW, gameweekRange.endGW);
  const normB = normalizeTransfers(transfersB, gameweekRange.startGW, gameweekRange.endGW);
  const normAll = normalizeTransfers(
    allLeagueTransfers.map((t) => ({ ...t, squadId: t.squadId })),
    gameweekRange.startGW,
    gameweekRange.endGW
  );

  // Compute rarity weights across the league
  const rarityWeights = computeTransferRarityWeights(
    normAll.map((t, i) => ({ ...t, squadId: allLeagueTransfers[i].squadId })),
    gameweekRange
  );

  // Extract sequences
  const seqA = extractTransferSequences(normA, config.timeWindowMinutes);
  const seqB = extractTransferSequences(normB, config.timeWindowMinutes);

  // Filter sequences by minimum size
  const validSeqA = seqA.filter((s) => s.length >= config.minTransfersInSequence);
  const validSeqB = seqB.filter((s) => s.length >= config.minTransfersInSequence);

  // Compare all pairs
  const comparisons: TransferSimilarityEvidence['pairwiseComparisons'] = [];
  let maxSimilarity = 0;

  for (let i = 0; i < validSeqA.length; i++) {
    for (let j = 0; j < validSeqB.length; j++) {
      const similarity = compareSequences(validSeqA[i], validSeqB[j], rarityWeights, config.maxGameweekLag);

      if (similarity > 0) {
        const hashesA = validSeqA[i].map((t) => hashTransfer(t.playerInFplId, t.playerOutFplId));
        const hashesB = validSeqB[j].map((t) => hashTransfer(t.playerInFplId, t.playerOutFplId));
        const matchedHashes = hashesA.filter((h) => hashesB.includes(h));

        comparisons.push({
          sequenceIndexA: i,
          sequenceIndexB: j,
          similarity,
          matchedTransfers: matchedHashes.map((h) => {
            const [id1, id2] = h.split(':').map(Number);
            return {
              playerInFplId: id1,
              playerOutFplId: id2,
              rarity: rarityWeights.get(h) ?? 0,
            };
          }),
        });

        maxSimilarity = Math.max(maxSimilarity, similarity);
      }
    }
  }

  // Overall score is the maximum similarity found
  const score = maxSimilarity;

  const evidence: TransferSimilarityEvidence = {
    score,
    pairwiseComparisons: comparisons,
    overallScore: score,
    gameweekRange,
    config,
    sequencesCountA: validSeqA.length,
    sequencesCountB: validSeqB.length,
  };

  return { score, evidence };
}

/**
 * Compute transfer similarity in batch for multiple pairs.
 * Reuses rarity weights across all comparisons for efficiency.
 */
export function computeTransferSimilarityBatch(
  pairs: Array<{
    transfersA: (SquadTransfer & { playerIn: Player; playerOut: Player })[];
    transfersB: (SquadTransfer & { playerIn: Player; playerOut: Player })[];
  }>,
  allLeagueTransfers: Array<SquadTransfer & { playerIn: Player; playerOut: Player }>,
  gameweekRange: { startGW: number; endGW: number },
  config: TransferSimilarityConfig = DEFAULT_TRANSFER_SIMILARITY_CONFIG
): Array<{ score: number; evidence: TransferSimilarityEvidence }> {
  // Pre-compute rarity weights once for all pairs
  const normAll = normalizeTransfers(
    allLeagueTransfers.map((t) => ({ ...t, squadId: t.squadId })),
    gameweekRange.startGW,
    gameweekRange.endGW
  );
  const rarityWeights = computeTransferRarityWeights(
    normAll.map((t, i) => ({ ...t, squadId: allLeagueTransfers[i].squadId })),
    gameweekRange
  );

  return pairs.map(({ transfersA, transfersB }) => {
    const normA = normalizeTransfers(transfersA, gameweekRange.startGW, gameweekRange.endGW);
    const normB = normalizeTransfers(transfersB, gameweekRange.startGW, gameweekRange.endGW);

    const seqA = extractTransferSequences(normA, config.timeWindowMinutes);
    const seqB = extractTransferSequences(normB, config.timeWindowMinutes);

    const validSeqA = seqA.filter((s) => s.length >= config.minTransfersInSequence);
    const validSeqB = seqB.filter((s) => s.length >= config.minTransfersInSequence);

    const comparisons: TransferSimilarityEvidence['pairwiseComparisons'] = [];
    let maxSimilarity = 0;

    for (let i = 0; i < validSeqA.length; i++) {
      for (let j = 0; j < validSeqB.length; j++) {
        const similarity = compareSequences(validSeqA[i], validSeqB[j], rarityWeights, config.maxGameweekLag);

        if (similarity > 0) {
          const hashesA = validSeqA[i].map((t) => hashTransfer(t.playerInFplId, t.playerOutFplId));
          const hashesB = validSeqB[j].map((t) => hashTransfer(t.playerInFplId, t.playerOutFplId));
          const matchedHashes = hashesA.filter((h) => hashesB.includes(h));

          comparisons.push({
            sequenceIndexA: i,
            sequenceIndexB: j,
            similarity,
            matchedTransfers: matchedHashes.map((h) => {
              const [id1, id2] = h.split(':').map(Number);
              return {
                playerInFplId: id1,
                playerOutFplId: id2,
                rarity: rarityWeights.get(h) ?? 0,
              };
            }),
          });

          maxSimilarity = Math.max(maxSimilarity, similarity);
        }
      }
    }

    const score = maxSimilarity;
    const evidence: TransferSimilarityEvidence = {
      score,
      pairwiseComparisons: comparisons,
      overallScore: score,
      gameweekRange,
      config,
      sequencesCountA: validSeqA.length,
      sequencesCountB: validSeqB.length,
    };

    return { score, evidence };
  });
}
