import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeJson,
  computeEventLeafHash,
  computeMerkleRoot,
  generateMerkleProof,
  verifyMerkleProof,
  buildLeagueAuditBundle,
  verifyLeagueAuditBundle,
  generateAuditCertificateText,
  LeagueAuditEvent,
} from "../services/league/leagueAuditExporter.js";

test("League Cryptographic Audit Trail Export & SHA-256 Merkle Seal (Issue #361)", async (t) => {
  const sampleEvents: LeagueAuditEvent[] = [
    {
      id: "evt-1",
      sequence: 1,
      eventType: "LEAGUE_SETTINGS",
      leagueId: "league-premier-2026",
      timestamp: "2026-08-01T10:00:00.000Z",
      actor: "admin-system",
      payload: {
        title: "Premier League Season 2026/27",
        entryFeeUSDC: "50.00",
        maxParticipants: 20,
        prizeStructure: { first: 0.6, second: 0.3, third: 0.1 },
      },
    },
    {
      id: "evt-2",
      sequence: 2,
      eventType: "MEMBER_ENTRY",
      leagueId: "league-premier-2026",
      timestamp: "2026-08-02T12:30:00.000Z",
      actor: "user-alice",
      payload: {
        participantId: "alice",
        depositTxHash: "0xabc123def456",
        amountUSDC: "50.00",
      },
    },
    {
      id: "evt-3",
      sequence: 3,
      eventType: "SQUAD_MUTATION",
      leagueId: "league-premier-2026",
      timestamp: "2026-08-03T15:45:00.000Z",
      actor: "user-alice",
      payload: {
        gameweek: 1,
        transfersIn: [101, 102],
        transfersOut: [201, 202],
        chipPlayed: "TRIPLE_CAPTAIN",
      },
    },
    {
      id: "evt-4",
      sequence: 4,
      eventType: "POINTS_AWARDED",
      leagueId: "league-premier-2026",
      timestamp: "2026-08-05T22:00:00.000Z",
      actor: "SYSTEM",
      payload: {
        gameweek: 1,
        scores: { alice: 84, bob: 72 },
        highestScorer: "alice",
      },
    },
    {
      id: "evt-5",
      sequence: 5,
      eventType: "PAYOUT_DISBURSED",
      leagueId: "league-premier-2026",
      timestamp: "2026-08-10T18:00:00.000Z",
      actor: "SYSTEM",
      payload: {
        payoutId: "payout-gw1-final",
        recipients: [{ recipient: "alice", payoutUSDC: "600.00" }],
        settlementTxHash: "0xfeedbeef9999",
      },
    },
  ];

  await t.test("Deterministic canonical JSON serialization handles arbitrary key order", () => {
    const objA = { z: 1, a: { y: 2, x: 3 }, m: [5, 4] };
    const objB = { a: { x: 3, y: 2 }, m: [5, 4], z: 1 };

    const jsonA = canonicalizeJson(objA);
    const jsonB = canonicalizeJson(objB);

    assert.equal(jsonA, jsonB);
    assert.equal(jsonA, '{"a":{"x":3,"y":2},"m":[5,4],"z":1}');
  });

  await t.test("Leaf hash is identical regardless of object key order", () => {
    const evt1: LeagueAuditEvent = {
      id: "evt-1",
      sequence: 1,
      eventType: "LEAGUE_SETTINGS",
      leagueId: "lg-1",
      timestamp: "2026-01-01T00:00:00Z",
      actor: "admin",
      payload: { b: 2, a: 1 },
    };
    const evt2: LeagueAuditEvent = {
      actor: "admin",
      eventType: "LEAGUE_SETTINGS",
      id: "evt-1",
      leagueId: "lg-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00Z",
      payload: { a: 1, b: 2 },
    };

    const hash1 = computeEventLeafHash(evt1);
    const hash2 = computeEventLeafHash(evt2);

    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });

  await t.test("Builds complete audit bundle with correct Merkle root", () => {
    const bundle = buildLeagueAuditBundle("league-premier-2026", sampleEvents, {
      exportedBy: "auditor-01",
    });

    assert.equal(bundle.leagueId, "league-premier-2026");
    assert.equal(bundle.totalEvents, 5);
    assert.equal(bundle.leaves.length, 5);
    assert.equal(typeof bundle.merkleRoot, "string");
    assert.equal(bundle.merkleRoot.length, 64);

    const verification = verifyLeagueAuditBundle(bundle);
    assert.equal(verification.valid, true);
    assert.equal(verification.calculatedRoot, bundle.merkleRoot);
    assert.equal(verification.tamperedEvents.length, 0);
  });

  await t.test("Merkle proof generation and verification for every leaf in the tree", () => {
    const bundle = buildLeagueAuditBundle("league-premier-2026", sampleEvents);

    for (let i = 0; i < bundle.leaves.length; i++) {
      const leaf = bundle.leaves[i];
      const proof = generateMerkleProof(bundle.leaves, i);
      const isVerified = verifyMerkleProof(leaf, proof, bundle.merkleRoot);

      assert.equal(isVerified, true, `Proof verification failed for leaf index ${i}`);
    }
  });

  await t.test("Tamper detection: Altering 1 bit in payload invalidates Merkle root and pinpoints tampered event", () => {
    const bundle = buildLeagueAuditBundle("league-premier-2026", sampleEvents);
    const tamperedBundle = JSON.parse(JSON.stringify(bundle));

    // Tamper with event 3: user-alice secretly changed chipPlayed
    tamperedBundle.events[2].payload.chipPlayed = "BENCH_BOOST";

    const result = verifyLeagueAuditBundle(tamperedBundle);

    assert.equal(result.valid, false);
    assert.ok(result.tamperedEvents.includes(2), "Should detect event index 2 was altered");
    assert.notEqual(result.calculatedRoot, tamperedBundle.merkleRoot);
    assert.match(result.error!, /Merkle root mismatch/);
  });

  await t.test("Tamper detection: Altering event sequence index triggers sequence discontinuity error", () => {
    const bundle = buildLeagueAuditBundle("league-premier-2026", sampleEvents);
    const tamperedBundle = JSON.parse(JSON.stringify(bundle));

    // Swap sequence numbers
    tamperedBundle.events[1].sequence = 99;

    const result = verifyLeagueAuditBundle(tamperedBundle);

    assert.equal(result.valid, false);
    assert.match(result.error!, /Sequence discontinuity/);
  });

  await t.test("Tamper detection: Deleting an event alters root and detects mismatch", () => {
    const bundle = buildLeagueAuditBundle("league-premier-2026", sampleEvents);
    const tamperedBundle = JSON.parse(JSON.stringify(bundle));

    // Delete event 2
    tamperedBundle.events.splice(1, 1);

    const result = verifyLeagueAuditBundle(tamperedBundle);

    assert.equal(result.valid, false);
  });

  await t.test("Generates human-readable printable audit certificate text", () => {
    const bundle = buildLeagueAuditBundle("league-premier-2026", sampleEvents);
    const certificate = generateAuditCertificateText(bundle);

    assert.match(certificate, /FANTASYXI LEAGUE CRYPTOGRAPHIC AUDIT CERTIFICATE/);
    assert.match(certificate, /SHA-256 MERKLE INTEGRITY SEAL VERIFICATION/);
    assert.match(certificate, /League Identifier\s+:\s+league-premier-2026/);
    assert.match(certificate, /Total Certified Events:\s+5/);
    assert.match(certificate, new RegExp(`0x${bundle.merkleRoot}`));
    assert.match(certificate, /LEAGUE_SETTINGS/);
    assert.match(certificate, /MEMBER_ENTRY/);
    assert.match(certificate, /PAYOUT_DISBURSED/);
    assert.match(certificate, /VERIFICATION INSTRUCTIONS/);
  });
});
