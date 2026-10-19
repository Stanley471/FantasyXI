import { prisma } from "../../config/db.js";
import {
  MerkleTree,
  MerkleProofStep,
  hashEventLeaf,
  sha256,
} from "./merkleTree.js";
import { canonicalizePayload } from "./cryptoAuditLog.js";
import { generateAuditCertificatePdf } from "./pdfCertificate.js";

export type LeagueAuditEventType =
  | "LEAGUE_CREATED"
  | "LEAGUE_CONFIG_UPDATED"
  | "PARTICIPANT_JOINED"
  | "SQUAD_SUBMISSION"
  | "TRANSFER_EXECUTED"
  | "POINT_AWARD"
  | "CHIP_PLAYED"
  | "PAYOUT_SETTLED";

export interface LeagueAuditEvent {
  index: number;
  eventId: string;
  eventType: LeagueAuditEventType;
  leagueId: string;
  gameweek: number;
  timestamp: string; // ISO 8601 UTC
  actorId: string;
  payload: Record<string, unknown>;
  leafHash: string;
  proof?: MerkleProofStep[];
}

export interface GameweekIntegritySeal {
  leagueId: string;
  gameweek: number | "ALL";
  merkleRoot: string;
  sealHash: string;
  eventCount: number;
  firstEventIndex: number;
  lastEventIndex: number;
  generatedAt: string;
  previousSealHash: string;
}

export interface LeagueAuditPackage {
  version: string;
  schema: string;
  league: {
    id: string;
    name: string;
    scoringType: string;
    entryFee: string;
    creatorId: string;
    createdAt: string;
  };
  gameweek: number | "ALL";
  seal: GameweekIntegritySeal;
  events: LeagueAuditEvent[];
  verificationInstructions: string[];
}

export interface AuditVerificationResult {
  valid: boolean;
  totalEvents: number;
  verifiedEvents: number;
  merkleRoot: string;
  tamperedIndex?: number;
  corruptEventId?: string;
  error?: string;
}

const DEFAULT_VERIFICATION_INSTRUCTIONS = [
  "1. For each event in 'events', compute canonical JSON of {index, eventId, eventType, leagueId, gameweek, timestamp, actorId, payload}.",
  "2. Hash the canonical string: leafHash = sha256('LEAF:' + canonicalPayload). Verify it equals 'leafHash'.",
  "3. Construct a binary Merkle tree pairing sibling nodes with sha256('NODE:' + left + ':' + right).",
  "4. Assert that the computed Merkle root equals seal.merkleRoot.",
  "5. Assert that each event's inclusion proof verifies mathematically to seal.merkleRoot.",
  "6. Verify seal.sealHash = sha256(canonicalize({leagueId, gameweek, merkleRoot, eventCount, generatedAt, previousSealHash}))."
];

export class LeagueAuditService {
  /**
   * Builds an integrity seal from an array of raw journal events.
   * Deterministically orders events, indexes them, derives leaf hashes, and builds the Merkle tree.
   */
  public buildAuditTrail(
    leagueId: string,
    gameweek: number | "ALL",
    rawEvents: Omit<LeagueAuditEvent, "index" | "leafHash" | "proof">[],
    previousSealHash: string = "0".repeat(64)
  ): {
    seal: GameweekIntegritySeal;
    events: LeagueAuditEvent[];
    tree: MerkleTree;
  } {
    // 1. Sort events deterministically: timestamp ASC, eventType ASC, eventId ASC
    const sorted = [...rawEvents].sort((a, b) => {
      const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      if (timeDiff !== 0) return timeDiff;
      const typeDiff = a.eventType.localeCompare(b.eventType);
      if (typeDiff !== 0) return typeDiff;
      return a.eventId.localeCompare(b.eventId);
    });

    // 2. Assign strictly increasing sequential index and compute leafHash
    const indexedEvents: LeagueAuditEvent[] = sorted.map((evt, idx) => {
      const canonicalRecord = {
        index: idx,
        eventId: evt.eventId,
        eventType: evt.eventType,
        leagueId: evt.leagueId,
        gameweek: evt.gameweek,
        timestamp: evt.timestamp,
        actorId: evt.actorId,
        payload: evt.payload,
      };

      const leafHash = hashEventLeaf(canonicalRecord);
      return {
        ...evt,
        index: idx,
        leafHash,
      };
    });

    // 3. Build Merkle tree from leaf hashes
    const leafHashes = indexedEvents.map((e) => e.leafHash);
    const tree = new MerkleTree(leafHashes);
    const merkleRoot = tree.getRoot();

    // 4. Attach inclusion proof to each event
    const eventsWithProof: LeagueAuditEvent[] = indexedEvents.map((evt) => ({
      ...evt,
      proof: tree.getProof(evt.index),
    }));

    // 5. Generate integrity seal
    const generatedAt = new Date().toISOString();
    const eventCount = eventsWithProof.length;
    const firstEventIndex = eventCount > 0 ? 0 : -1;
    const lastEventIndex = eventCount > 0 ? eventCount - 1 : -1;

    const sealPayload = {
      leagueId,
      gameweek,
      merkleRoot,
      eventCount,
      firstEventIndex,
      lastEventIndex,
      generatedAt,
      previousSealHash,
    };
    const sealHash = sha256(`SEAL:${canonicalizePayload(sealPayload)}`);

    const seal: GameweekIntegritySeal = {
      leagueId,
      gameweek,
      merkleRoot,
      sealHash,
      eventCount,
      firstEventIndex,
      lastEventIndex,
      generatedAt,
      previousSealHash,
    };

    return { seal, events: eventsWithProof, tree };
  }

  /**
   * Fetches league events from the database using clean, non-locking read queries.
   */
  public async collectLeagueEvents(
    leagueId: string,
    gameweekNumber?: number
  ): Promise<{
    league: {
      id: string;
      name: string;
      scoringType: string;
      entryFee: string;
      creatorId: string;
      createdAt: string;
    };
    events: Omit<LeagueAuditEvent, "index" | "leafHash" | "proof">[];
  }> {
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
    });

    if (!league) {
      throw new Error(`League not found: ${leagueId}`);
    }

    const events: Omit<LeagueAuditEvent, "index" | "leafHash" | "proof">[] = [];

    // 1. League Creation Event
    events.push({
      eventId: `evt_league_create_${league.id}`,
      eventType: "LEAGUE_CREATED",
      leagueId: league.id,
      gameweek: league.startGameweekId || 1,
      timestamp: league.createdAt.toISOString(),
      actorId: league.creatorId,
      payload: {
        name: league.name,
        scoringType: league.scoringType,
        entryFee: league.entryFee?.toString() ?? "0",
        maxMembers: league.maxMembers,
        minMembers: league.minMembers,
        startGameweekId: league.startGameweekId,
        endGameweekId: league.endGameweekId,
      },
    });

    // 2. League Members Registered
    const members = await prisma.leagueMember.findMany({
      where: { leagueId },
      include: { squad: true },
      orderBy: { joinedAt: "asc" },
    });

    for (const member of members) {
      events.push({
        eventId: `evt_member_join_${member.id}`,
        eventType: "PARTICIPANT_JOINED",
        leagueId: league.id,
        gameweek: league.startGameweekId || 1,
        timestamp: member.joinedAt.toISOString(),
        actorId: member.userId,
        payload: {
          memberId: member.id,
          userId: member.userId,
          squadId: member.squadId,
          teamName: member.squad?.name || "Squad",
          paymentStatus: member.paymentStatus,
        },
      });
    }

    // Get user IDs for members
    const memberUserIds = members.map((m) => m.userId);

    // 3. Squads for members
    const squads = await prisma.squad.findMany({
      where: { userId: { in: memberUserIds } },
      select: { id: true, userId: true, name: true },
    });
    const squadIds = squads.map((s) => s.id);
    const squadMap = new Map(squads.map((s) => [s.id, s]));

    if (squadIds.length > 0) {
      // 4. Squad Transfers
      const transferWhere: any = {
        squadId: { in: squadIds },
      };
      if (gameweekNumber) {
        transferWhere.gameweekId = gameweekNumber;
      }

      const transfers = await prisma.squadTransfer.findMany({
        where: transferWhere,
        include: { gameweek: true },
        orderBy: { timestamp: "asc" },
      });

      for (const tx of transfers) {
        const squad = squadMap.get(tx.squadId);
        events.push({
          eventId: `evt_transfer_${tx.id}`,
          eventType: "TRANSFER_EXECUTED",
          leagueId: league.id,
          gameweek: tx.gameweekId,
          timestamp: tx.timestamp.toISOString(),
          actorId: squad?.userId || "unknown",
          payload: {
            squadId: tx.squadId,
            playerInId: tx.playerInId,
            playerOutId: tx.playerOutId,
            inPrice: tx.inPrice?.toString() ?? "0",
            outPrice: tx.outPrice?.toString() ?? "0",
            pointsCost: tx.pointsCost,
          },
        });
      }

      // 5. Squad Gameweek Scores (Point Awards)
      const scoreWhere: any = {
        squadId: { in: squadIds },
      };
      if (gameweekNumber) {
        scoreWhere.gameweekId = gameweekNumber;
      }

      const scores = await prisma.squadGameweekScore.findMany({
        where: scoreWhere,
        include: { gameweek: true },
        orderBy: { calculatedAt: "asc" },
      });

      for (const sc of scores) {
        const squad = squadMap.get(sc.squadId);
        events.push({
          eventId: `evt_score_${sc.id}`,
          eventType: "POINT_AWARD",
          leagueId: league.id,
          gameweek: sc.gameweekId,
          timestamp: sc.calculatedAt.toISOString(),
          actorId: "system",
          payload: {
            squadId: sc.squadId,
            points: sc.points,
            benchPoints: sc.benchPoints,
            captainPoints: sc.captainPoints,
            transferCost: sc.transferCost,
          },
        });
      }
    }

    return {
      league: {
        id: league.id,
        name: league.name,
        scoringType: league.scoringType,
        entryFee: league.entryFee?.toString() ?? "0",
        creatorId: league.creatorId,
        createdAt: league.createdAt.toISOString(),
      },
      events,
    };
  }

  /**
   * Generates a complete downloadable audit package for a league and optional gameweek.
   */
  public async generateAuditPackage(
    leagueId: string,
    gameweekNumber?: number
  ): Promise<LeagueAuditPackage> {
    const { league, events } = await this.collectLeagueEvents(leagueId, gameweekNumber);
    const targetGw = gameweekNumber !== undefined ? gameweekNumber : "ALL";

    const { seal, events: sealedEvents } = this.buildAuditTrail(leagueId, targetGw, events);

    return {
      version: "1.0.0",
      schema: "https://fantasyxi.app/schemas/league-audit-v1.json",
      league,
      gameweek: targetGw,
      seal,
      events: sealedEvents,
      verificationInstructions: DEFAULT_VERIFICATION_INSTRUCTIONS,
    };
  }

  /**
   * Verifies an audit package against cryptographic tampering.
   */
  public verifyAuditPackage(pkg: LeagueAuditPackage): AuditVerificationResult {
    const { seal, events } = pkg;

    // 1. Verify seal hash integrity
    const sealPayload = {
      leagueId: seal.leagueId,
      gameweek: seal.gameweek,
      merkleRoot: seal.merkleRoot,
      eventCount: seal.eventCount,
      firstEventIndex: seal.firstEventIndex,
      lastEventIndex: seal.lastEventIndex,
      generatedAt: seal.generatedAt,
      previousSealHash: seal.previousSealHash,
    };
    const expectedSealHash = sha256(`SEAL:${canonicalizePayload(sealPayload)}`);

    if (expectedSealHash !== seal.sealHash) {
      return {
        valid: false,
        totalEvents: events.length,
        verifiedEvents: 0,
        merkleRoot: seal.merkleRoot,
        error: `Integrity seal tampering detected: sealHash ${seal.sealHash} does not match computed ${expectedSealHash}`,
      };
    }

    if (events.length !== seal.eventCount) {
      return {
        valid: false,
        totalEvents: events.length,
        verifiedEvents: 0,
        merkleRoot: seal.merkleRoot,
        error: `Event count mismatch: seal recorded ${seal.eventCount} events, but package contains ${events.length}`,
      };
    }

    // 2. Verify each event leaf hash and sequence
    const leafHashes: string[] = [];

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];

      if (evt.index !== i) {
        return {
          valid: false,
          totalEvents: events.length,
          verifiedEvents: i,
          merkleRoot: seal.merkleRoot,
          tamperedIndex: i,
          corruptEventId: evt.eventId,
          error: `Sequence ordering violation at index ${i}: expected index ${i}, found ${evt.index}`,
        };
      }

      const canonicalRecord = {
        index: evt.index,
        eventId: evt.eventId,
        eventType: evt.eventType,
        leagueId: evt.leagueId,
        gameweek: evt.gameweek,
        timestamp: evt.timestamp,
        actorId: evt.actorId,
        payload: evt.payload,
      };

      const computedLeafHash = hashEventLeaf(canonicalRecord);

      if (computedLeafHash !== evt.leafHash) {
        return {
          valid: false,
          totalEvents: events.length,
          verifiedEvents: i,
          merkleRoot: seal.merkleRoot,
          tamperedIndex: i,
          corruptEventId: evt.eventId,
          error: `Event data alteration detected at index ${i} (${evt.eventId}): leafHash does not match canonical payload`,
        };
      }

      // 3. Verify individual inclusion proof if attached
      if (evt.proof) {
        const isProofValid = MerkleTree.verifyProof(evt.leafHash, evt.proof, seal.merkleRoot);
        if (!isProofValid) {
          return {
            valid: false,
            totalEvents: events.length,
            verifiedEvents: i,
            merkleRoot: seal.merkleRoot,
            tamperedIndex: i,
            corruptEventId: evt.eventId,
            error: `Merkle inclusion proof failed for event at index ${i} (${evt.eventId})`,
          };
        }
      }

      leafHashes.push(evt.leafHash);
    }

    // 4. Reconstruct Merkle tree from all leaves and verify root matches seal
    const reconstructedTree = new MerkleTree(leafHashes);
    const computedRoot = reconstructedTree.getRoot();

    if (computedRoot !== seal.merkleRoot) {
      return {
        valid: false,
        totalEvents: events.length,
        verifiedEvents: events.length,
        merkleRoot: seal.merkleRoot,
        error: `Merkle root mismatch: computed root ${computedRoot} != seal root ${seal.merkleRoot}`,
      };
    }

    return {
      valid: true,
      totalEvents: events.length,
      verifiedEvents: events.length,
      merkleRoot: seal.merkleRoot,
    };
  }

  /**
   * Generates a downloadable PDF certificate for the audit package.
   */
  public generatePdfCertificate(pkg: LeagueAuditPackage): Buffer {
    return generateAuditCertificatePdf({
      title: "FANTASY XI - LEAGUE AUDIT INTEGRITY CERTIFICATE",
      leagueId: pkg.league.id,
      leagueName: pkg.league.name,
      gameweek: pkg.gameweek,
      eventCount: pkg.seal.eventCount,
      merkleRoot: pkg.seal.merkleRoot,
      sealHash: pkg.seal.sealHash,
      generatedAt: pkg.seal.generatedAt,
      verificationInstructions: pkg.verificationInstructions,
    });
  }
}

export const leagueAuditService = new LeagueAuditService();
