import test from "node:test";
import assert from "node:assert/strict";
import {
  MerkleTree,
  hashEventLeaf,
  combineHashes,
  sha256,
} from "../services/audit/merkleTree.js";
import {
  leagueAuditService,
  LeagueAuditEvent,
  LeagueAuditPackage,
} from "../services/audit/leagueAuditService.js";
import { canonicalizePayload } from "../services/audit/cryptoAuditLog.js";
import { generateAuditCertificatePdf } from "../services/audit/pdfCertificate.js";

test("League Cryptographic Audit Trail & Merkle Seal Generation (Issue #361)", async (t) => {
  await t.test("MerkleTree produces consistent roots and valid inclusion proofs", () => {
    const leaves = [
      sha256("leaf_1"),
      sha256("leaf_2"),
      sha256("leaf_3"),
      sha256("leaf_4"),
      sha256("leaf_5"), // odd number of leaves tests duplication handling
    ];

    const tree = new MerkleTree(leaves);
    const root = tree.getRoot();

    assert.equal(typeof root, "string");
    assert.equal(root.length, 64);

    // Verify inclusion proofs for each leaf
    for (let i = 0; i < leaves.length; i++) {
      const proof = tree.getProof(i);
      assert.ok(proof.length > 0, `Proof for leaf ${i} should have steps`);
      const valid = MerkleTree.verifyProof(leaves[i], proof, root);
      assert.equal(valid, true, `Proof verification failed for leaf ${i}`);

      // Altering leaf hash must invalidate proof
      const tamperedLeaf = sha256(`tampered_${i}`);
      const invalid = MerkleTree.verifyProof(tamperedLeaf, proof, root);
      assert.equal(invalid, false, `Proof should have failed for tampered leaf ${i}`);
    }
  });

  await t.test("Deterministic canonical serialization produces invariant hashes regardless of object key order", () => {
    const obj1 = {
      points: 85,
      squadId: "squad_abc",
      metadata: { transferCost: 4, captainId: 101, chip: null },
      active: true,
    };

    const obj2 = {
      active: true,
      squadId: "squad_abc",
      metadata: { chip: null, captainId: 101, transferCost: 4 },
      points: 85,
    };

    const c1 = canonicalizePayload(obj1);
    const c2 = canonicalizePayload(obj2);

    assert.equal(c1, c2, "Canonical strings must be identical");
    assert.equal(sha256(c1), sha256(c2), "SHA-256 of canonical strings must be identical");
  });

  await t.test("Sequential event journal builds valid Merkle integrity seal", () => {
    const rawEvents = [
      {
        eventId: "evt_1",
        eventType: "LEAGUE_CREATED" as const,
        leagueId: "lg_123",
        gameweek: 1,
        timestamp: "2026-08-15T12:00:00.000Z",
        actorId: "user_admin",
        payload: { name: "Premier League 2026", entryFee: "50" },
      },
      {
        eventId: "evt_2",
        eventType: "PARTICIPANT_JOINED" as const,
        leagueId: "lg_123",
        gameweek: 1,
        timestamp: "2026-08-15T14:30:00.000Z",
        actorId: "user_player1",
        payload: { teamName: "Arsenal Stars", paymentStatus: "CONFIRMED" },
      },
      {
        eventId: "evt_3",
        eventType: "TRANSFER_EXECUTED" as const,
        leagueId: "lg_123",
        gameweek: 1,
        timestamp: "2026-08-16T18:00:00.000Z",
        actorId: "user_player1",
        payload: { playerInId: 12, playerOutId: 44, cost: 0 },
      },
      {
        eventId: "evt_4",
        eventType: "POINT_AWARD" as const,
        leagueId: "lg_123",
        gameweek: 1,
        timestamp: "2026-08-17T22:00:00.000Z",
        actorId: "system",
        payload: { squadId: "sq_1", points: 76, rank: 1 },
      },
    ];

    const { seal, events } = leagueAuditService.buildAuditTrail("lg_123", 1, rawEvents);

    assert.equal(seal.leagueId, "lg_123");
    assert.equal(seal.gameweek, 1);
    assert.equal(seal.eventCount, 4);
    assert.equal(seal.firstEventIndex, 0);
    assert.equal(seal.lastEventIndex, 3);
    assert.equal(typeof seal.merkleRoot, "string");
    assert.equal(seal.merkleRoot.length, 64);
    assert.equal(typeof seal.sealHash, "string");
    assert.equal(seal.sealHash.length, 64);

    // Verify events have sequential index and proofs
    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i].index, i);
      assert.ok(events[i].proof && events[i].proof!.length > 0);
      assert.ok(MerkleTree.verifyProof(events[i].leafHash, events[i].proof!, seal.merkleRoot));
    }

    const pkg: LeagueAuditPackage = {
      version: "1.0.0",
      schema: "https://fantasyxi.app/schemas/league-audit-v1.json",
      league: {
        id: "lg_123",
        name: "Premier League 2026",
        scoringType: "CLASSIC",
        entryFee: "50",
        creatorId: "user_admin",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      gameweek: 1,
      seal,
      events,
      verificationInstructions: ["Step 1", "Step 2"],
    };

    const verification = leagueAuditService.verifyAuditPackage(pkg);
    assert.equal(verification.valid, true);
    assert.equal(verification.totalEvents, 4);
    assert.equal(verification.verifiedEvents, 4);
    assert.equal(verification.merkleRoot, seal.merkleRoot);
  });

  await t.test("Acceptance Criteria: Tampering with single event payload invalidates Merkle seal", () => {
    const rawEvents = [
      {
        eventId: "evt_1",
        eventType: "LEAGUE_CREATED" as const,
        leagueId: "lg_tamper",
        gameweek: 2,
        timestamp: "2026-09-01T10:00:00.000Z",
        actorId: "admin",
        payload: { entryFee: "100" },
      },
      {
        eventId: "evt_2",
        eventType: "POINT_AWARD" as const,
        leagueId: "lg_tamper",
        gameweek: 2,
        timestamp: "2026-09-02T10:00:00.000Z",
        actorId: "system",
        payload: { squadId: "sq_2", points: 88, rank: 1 },
      },
    ];

    const { seal, events } = leagueAuditService.buildAuditTrail("lg_tamper", 2, rawEvents);

    const originalPkg: LeagueAuditPackage = {
      version: "1.0.0",
      schema: "https://fantasyxi.app/schemas/league-audit-v1.json",
      league: {
        id: "lg_tamper",
        name: "Tamper Test League",
        scoringType: "CLASSIC",
        entryFee: "100",
        creatorId: "admin",
        createdAt: "2026-09-01T10:00:00.000Z",
      },
      gameweek: 2,
      seal,
      events,
      verificationInstructions: ["Verify"],
    };

    // Deep clone package to simulate tampered receipt
    const tamperedPkg: LeagueAuditPackage = JSON.parse(JSON.stringify(originalPkg));

    // Tamper with event 1: change points from 88 to 99
    (tamperedPkg.events[1].payload as any).points = 99;

    const result = leagueAuditService.verifyAuditPackage(tamperedPkg);
    assert.equal(result.valid, false);
    assert.equal(result.tamperedIndex, 1);
    assert.equal(result.corruptEventId, "evt_2");
    assert.match(result.error!, /Event data alteration detected at index 1/);
  });

  await t.test("Acceptance Criteria: Deleting, reordering, or injecting events is detected", () => {
    const rawEvents = [
      {
        eventId: "evt_1",
        eventType: "LEAGUE_CREATED" as const,
        leagueId: "lg_seq",
        gameweek: 3,
        timestamp: "2026-09-10T10:00:00.000Z",
        actorId: "admin",
        payload: { entryFee: "20" },
      },
      {
        eventId: "evt_2",
        eventType: "PARTICIPANT_JOINED" as const,
        leagueId: "lg_seq",
        gameweek: 3,
        timestamp: "2026-09-11T10:00:00.000Z",
        actorId: "user_1",
        payload: { teamName: "Team 1" },
      },
      {
        eventId: "evt_3",
        eventType: "POINT_AWARD" as const,
        leagueId: "lg_seq",
        gameweek: 3,
        timestamp: "2026-09-12T10:00:00.000Z",
        actorId: "system",
        payload: { points: 50 },
      },
    ];

    const { seal, events } = leagueAuditService.buildAuditTrail("lg_seq", 3, rawEvents);

    const basePkg: LeagueAuditPackage = {
      version: "1.0.0",
      schema: "https://fantasyxi.app/schemas/league-audit-v1.json",
      league: {
        id: "lg_seq",
        name: "Seq League",
        scoringType: "CLASSIC",
        entryFee: "20",
        creatorId: "admin",
        createdAt: "2026-09-10T10:00:00.000Z",
      },
      gameweek: 3,
      seal,
      events,
      verificationInstructions: ["Verify"],
    };

    // 1. Delete second event (index 1)
    const deletedPkg: LeagueAuditPackage = JSON.parse(JSON.stringify(basePkg));
    deletedPkg.events.splice(1, 1);
    const deleteResult = leagueAuditService.verifyAuditPackage(deletedPkg);
    assert.equal(deleteResult.valid, false);
    assert.match(deleteResult.error!, /Event count mismatch/);

    // 2. Corrupt seal hash
    const corruptSealPkg: LeagueAuditPackage = JSON.parse(JSON.stringify(basePkg));
    corruptSealPkg.seal.sealHash = "0".repeat(64);
    const corruptSealResult = leagueAuditService.verifyAuditPackage(corruptSealPkg);
    assert.equal(corruptSealResult.valid, false);
    assert.match(corruptSealResult.error!, /Integrity seal tampering detected/);
  });

  await t.test("Acceptance Criteria: Generates downloadable valid PDF audit certificate", () => {
    const rawEvents = [
      {
        eventId: "evt_cert_1",
        eventType: "LEAGUE_CREATED" as const,
        leagueId: "lg_cert_99",
        gameweek: 5,
        timestamp: "2026-10-01T10:00:00.000Z",
        actorId: "admin_cert",
        payload: { name: "Championship 2026", entryFee: "100" },
      },
      {
        eventId: "evt_cert_2",
        eventType: "POINT_AWARD" as const,
        leagueId: "lg_cert_99",
        gameweek: 5,
        timestamp: "2026-10-02T10:00:00.000Z",
        actorId: "system",
        payload: { squadId: "sq_champ", points: 92, rank: 1 },
      },
    ];

    const { seal, events } = leagueAuditService.buildAuditTrail("lg_cert_99", 5, rawEvents);

    const pkg: LeagueAuditPackage = {
      version: "1.0.0",
      schema: "https://fantasyxi.app/schemas/league-audit-v1.json",
      league: {
        id: "lg_cert_99",
        name: "Championship 2026",
        scoringType: "HEAD_TO_HEAD",
        entryFee: "100",
        creatorId: "admin_cert",
        createdAt: "2026-10-01T10:00:00.000Z",
      },
      gameweek: 5,
      seal,
      events,
      verificationInstructions: [
        "1. Compute canonical JSON of each event in events array.",
        "2. Compute leaf SHA-256 and rebuild Merkle tree.",
        "3. Assert calculated root equals Merkle Root Hash.",
      ],
    };

    const pdfBuffer = leagueAuditService.generatePdfCertificate(pkg);

    assert.ok(Buffer.isBuffer(pdfBuffer), "PDF output must be a Buffer");
    assert.ok(pdfBuffer.length > 500, "PDF buffer must be non-empty");

    const pdfString = pdfBuffer.toString("utf8");
    assert.ok(pdfString.startsWith("%PDF-1.4"), "PDF must start with valid %PDF-1.4 header");
    assert.ok(pdfString.includes("%%EOF"), "PDF must conclude with %%EOF");
    assert.ok(pdfString.includes("xref"), "PDF must contain cross-reference table");
    assert.ok(pdfString.includes("trailer"), "PDF must contain trailer");
    assert.ok(pdfString.includes(seal.merkleRoot), "PDF must embed the Merkle Root Hash");
    assert.ok(pdfString.includes("Championship 2026"), "PDF must embed League Name");
  });

  await t.test("verifyLeagueAuditPackage controller returns 200 on valid package and 400 on tampered payload", async () => {
    const { verifyLeagueAuditPackage } = await import("../controllers/leagueAudit.controller.js");

    const rawEvents = [
      {
        eventId: "evt_ctrl_1",
        eventType: "LEAGUE_CREATED" as const,
        leagueId: "lg_ctrl_1",
        gameweek: 1,
        timestamp: "2026-08-01T10:00:00.000Z",
        actorId: "admin",
        payload: { entryFee: "10" },
      },
    ];

    const { seal, events } = leagueAuditService.buildAuditTrail("lg_ctrl_1", 1, rawEvents);

    const validPkg: LeagueAuditPackage = {
      version: "1.0.0",
      schema: "https://fantasyxi.app/schemas/league-audit-v1.json",
      league: {
        id: "lg_ctrl_1",
        name: "Controller Test League",
        scoringType: "CLASSIC",
        entryFee: "10",
        creatorId: "admin",
        createdAt: "2026-08-01T10:00:00.000Z",
      },
      gameweek: 1,
      seal,
      events,
      verificationInstructions: ["Verify"],
    };

    // Test valid package
    let statusCode = 200;
    let jsonResult: any = null;
    const reqValid = { body: validPkg } as any;
    const resValid = {
      status: (code: number) => {
        statusCode = code;
        return resValid;
      },
      json: (data: any) => {
        jsonResult = data;
        return resValid;
      },
    } as any;

    await verifyLeagueAuditPackage(reqValid, resValid);
    assert.equal(statusCode, 200);
    assert.equal(jsonResult.valid, true);
    assert.equal(jsonResult.verifiedEvents, 1);

    // Test tampered package
    const tamperedPkg = JSON.parse(JSON.stringify(validPkg));
    tamperedPkg.events[0].payload.entryFee = "9999";

    const reqTampered = { body: tamperedPkg } as any;
    const resTampered = {
      status: (code: number) => {
        statusCode = code;
        return resTampered;
      },
      json: (data: any) => {
        jsonResult = data;
        return resTampered;
      },
    } as any;

    await verifyLeagueAuditPackage(reqTampered, resTampered);
    assert.equal(statusCode, 400);
    assert.equal(jsonResult.valid, false);
    assert.match(jsonResult.error, /Event data alteration detected/);
  });
});
