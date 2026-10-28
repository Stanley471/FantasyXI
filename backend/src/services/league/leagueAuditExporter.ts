import crypto from "crypto";

export interface LeagueAuditEvent {
  id: string;
  sequence: number;
  eventType:
    | "LEAGUE_SETTINGS"
    | "MEMBER_ENTRY"
    | "SQUAD_MUTATION"
    | "POINTS_AWARDED"
    | "PAYOUT_DISBURSED"
    | string;
  leagueId: string;
  timestamp: string;
  actor: string;
  payload: Record<string, unknown>;
}

export interface MerkleProofStep {
  position: "left" | "right";
  hash: string;
}

export interface LeagueAuditBundle {
  version: "1.0";
  leagueId: string;
  exportedAt: string;
  totalEvents: number;
  merkleRoot: string;
  leaves: string[];
  events: LeagueAuditEvent[];
  metadata?: Record<string, unknown>;
}

export interface AuditIntegrityResult {
  valid: boolean;
  calculatedRoot: string;
  expectedRoot: string;
  tamperedEvents: number[];
  error?: string;
}

/**
 * Deterministically serialize any JavaScript value to canonical JSON.
 * Keys in objects are sorted alphabetically at every nesting depth.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`
  );
  return `{${pairs.join(",")}}`;
}

/**
 * Computes the SHA-256 leaf hash of a single audit event.
 */
export function computeEventLeafHash(event: LeagueAuditEvent): string {
  const canonical = canonicalizeJson({
    id: event.id,
    sequence: event.sequence,
    eventType: event.eventType,
    leagueId: event.leagueId,
    timestamp: event.timestamp,
    actor: event.actor,
    payload: event.payload,
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Computes the Merkle Root of an array of leaf hashes using SHA-256.
 * If the number of leaves is odd, the last leaf is duplicated.
 */
export function computeMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) {
    return "0000000000000000000000000000000000000000000000000000000000000000";
  }
  if (leaves.length === 1) {
    return leaves[0];
  }

  let currentLevel = [...leaves];

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    if (currentLevel.length % 2 !== 0) {
      currentLevel.push(currentLevel[currentLevel.length - 1]);
    }

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1];
      const combined = crypto
        .createHash("sha256")
        .update(left + right, "utf8")
        .digest("hex");
      nextLevel.push(combined);
    }

    currentLevel = nextLevel;
  }

  return currentLevel[0];
}

/**
 * Computes a Merkle audit proof for a specific leaf index.
 */
export function generateMerkleProof(leaves: string[], targetIndex: number): MerkleProofStep[] {
  if (targetIndex < 0 || targetIndex >= leaves.length) {
    throw new Error(`Target index ${targetIndex} out of bounds for leaves of length ${leaves.length}`);
  }

  const proof: MerkleProofStep[] = [];
  let currentLevel = [...leaves];
  let currentIndex = targetIndex;

  while (currentLevel.length > 1) {
    if (currentLevel.length % 2 !== 0) {
      currentLevel.push(currentLevel[currentLevel.length - 1]);
    }

    const isRightNode = currentIndex % 2 === 1;
    const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

    proof.push({
      position: isRightNode ? "left" : "right",
      hash: currentLevel[siblingIndex],
    });

    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1];
      const combined = crypto
        .createHash("sha256")
        .update(left + right, "utf8")
        .digest("hex");
      nextLevel.push(combined);
    }

    currentLevel = nextLevel;
    currentIndex = Math.floor(currentIndex / 2);
  }

  return proof;
}

/**
 * Verifies a Merkle proof against an expected Merkle root.
 */
export function verifyMerkleProof(
  leafHash: string,
  proof: MerkleProofStep[],
  expectedRoot: string
): boolean {
  let currentHash = leafHash;

  for (const step of proof) {
    if (step.position === "left") {
      currentHash = crypto
        .createHash("sha256")
        .update(step.hash + currentHash, "utf8")
        .digest("hex");
    } else {
      currentHash = crypto
        .createHash("sha256")
        .update(currentHash + step.hash, "utf8")
        .digest("hex");
    }
  }

  return currentHash === expectedRoot;
}

/**
 * Builds a certified League Audit Bundle with SHA-256 Merkle root.
 */
export function buildLeagueAuditBundle(
  leagueId: string,
  events: LeagueAuditEvent[],
  metadata?: Record<string, unknown>
): LeagueAuditBundle {
  // Sort events strictly by sequence
  const sortedEvents = [...events].sort((a, b) => a.sequence - b.sequence);

  // Compute leaf hashes
  const leaves = sortedEvents.map((evt) => computeEventLeafHash(evt));
  const merkleRoot = computeMerkleRoot(leaves);

  return {
    version: "1.0",
    leagueId,
    exportedAt: new Date().toISOString(),
    totalEvents: sortedEvents.length,
    merkleRoot,
    leaves,
    events: sortedEvents,
    metadata,
  };
}

/**
 * Verifies the mathematical integrity of a league audit bundle.
 * Detects any tampered events or invalid Merkle roots.
 */
export function verifyLeagueAuditBundle(bundle: LeagueAuditBundle): AuditIntegrityResult {
  const tamperedEvents: number[] = [];

  // Check sequence continuity
  for (let i = 0; i < bundle.events.length; i++) {
    const expectedSeq = i + 1;
    if (bundle.events[i].sequence !== expectedSeq) {
      return {
        valid: false,
        calculatedRoot: "",
        expectedRoot: bundle.merkleRoot,
        tamperedEvents: [i],
        error: `Sequence discontinuity at index ${i}: expected ${expectedSeq}, got ${bundle.events[i].sequence}`,
      };
    }
  }

  // Recompute leaf hashes and check against recorded leaves
  const recomputedLeaves: string[] = [];
  for (let i = 0; i < bundle.events.length; i++) {
    const leaf = computeEventLeafHash(bundle.events[i]);
    recomputedLeaves.push(leaf);
    if (bundle.leaves[i] && leaf !== bundle.leaves[i]) {
      tamperedEvents.push(i);
    }
  }

  const calculatedRoot = computeMerkleRoot(recomputedLeaves);

  if (calculatedRoot !== bundle.merkleRoot) {
    return {
      valid: false,
      calculatedRoot,
      expectedRoot: bundle.merkleRoot,
      tamperedEvents: tamperedEvents.length > 0 ? tamperedEvents : [0],
      error: `Merkle root mismatch: computed ${calculatedRoot} != bundle ${bundle.merkleRoot}`,
    };
  }

  return {
    valid: true,
    calculatedRoot,
    expectedRoot: bundle.merkleRoot,
    tamperedEvents: [],
  };
}

/**
 * Generates a human-readable and printable audit certificate document.
 */
export function generateAuditCertificateText(bundle: LeagueAuditBundle): string {
  const divider = "=".repeat(78);
  const subDivider = "-".repeat(78);

  const eventCountsByType = bundle.events.reduce<Record<string, number>>((acc, evt) => {
    acc[evt.eventType] = (acc[evt.eventType] || 0) + 1;
    return acc;
  }, {});

  const breakdownLines = Object.entries(eventCountsByType)
    .map(([type, count]) => `  - ${type.padEnd(20)}: ${count} event(s)`)
    .join("\n");

  return [
    divider,
    "              FANTASYXI LEAGUE CRYPTOGRAPHIC AUDIT CERTIFICATE",
    "               SHA-256 MERKLE INTEGRITY SEAL VERIFICATION",
    divider,
    "",
    `  League Identifier     : ${bundle.leagueId}`,
    `  Audit Export Timestamp: ${bundle.exportedAt}`,
    `  Total Certified Events: ${bundle.totalEvents}`,
    `  Protocol Version      : ${bundle.version}`,
    "",
    subDivider,
    "  CRYPTOGRAPHIC MERKLE ROOT SEAL",
    subDivider,
    `  SHA-256 Root : 0x${bundle.merkleRoot}`,
    "",
    subDivider,
    "  EVENT JOURNAL SUMMARY BREAKDOWN",
    subDivider,
    breakdownLines || "  No events recorded.",
    "",
    subDivider,
    "  VERIFICATION INSTRUCTIONS",
    subDivider,
    "  1. Order certified events by 'sequence' (1 .. N).",
    "  2. Compute canonical JSON representation of each event with sorted keys.",
    "  3. Calculate SHA-256 leaf hash for each event.",
    "  4. Fold pairwise SHA-256 hashes upwards until root is reached.",
    "  5. Verify that root equals the SHA-256 Root specified above.",
    "",
    divider,
    "   GUARANTEED TAMPER-EVIDENT RECORD BY FANTASYXI GOVERNANCE PROTOCOL",
    divider,
  ].join("\n");
}
