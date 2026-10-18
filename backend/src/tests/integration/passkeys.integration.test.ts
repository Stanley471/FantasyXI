import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { prisma } from "../../config/db.js";
import { verifyAccessToken } from "../../config/jwt.js";
import { WebAuthnService, WebAuthnVerificationError } from "../../services/auth/webauthnService.js";
import { SoftAuthenticator } from "../helpers/softAuthenticator.js";

/**
 * Passkey registration and authentication ceremonies (issue #273) against a
 * real PostgreSQL database with the Prisma schema pushed. Skipped when no
 * database is reachable.
 */

const db = prisma as any;
const ORIGIN = "https://fantasyxi.test";
const RP_ID = "fantasyxi.test";
const noSecurity = { handleSuccessfulLogin: async () => undefined } as any;
const service = new WebAuthnService(db, { rpID: RP_ID, rpName: "FantasyXI", origins: [ORIGIN], challengeTtlMs: 60_000 }, noSecurity);

let skip: string | false = false;
let userId = "";

describe("Passkey ceremonies (PostgreSQL integration, issue #273)", () => {
  before(async () => {
    try {
      await db.$queryRawUnsafe("SELECT 1 FROM passkey_credentials LIMIT 1");
    } catch (error) {
      skip = `database unreachable or schema not pushed (${(error as Error).message.split("\n")[0]})`;
      return;
    }
    const run = crypto.randomBytes(3).toString("hex");
    userId = (await db.user.create({ data: { email: `passkey-${run}@it.test`, username: `passkey_${run}` } })).id;
  });

  after(async () => {
    if (skip) return;
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it("registers two authenticators, signs in, and rejects replay and counter regression", async (t) => {
    if (skip) return t.skip(skip);

    const phone = new SoftAuthenticator(ORIGIN, RP_ID, ["internal"]);
    const key = new SoftAuthenticator(ORIGIN, RP_ID, ["usb"]);
    const phoneReg = phone.register(await service.startRegistration(userId));
    await service.finishRegistration(userId, phoneReg.response as any, "Phone");
    const keyReg = key.register(await service.startRegistration(userId));
    await service.finishRegistration(userId, keyReg.response as any, "Security key");
    assert.equal((await service.listPasskeys(userId)).length, 2);

    const options = await service.startAuthentication();
    const assertion = phone.assert(options.challenge, phoneReg.credential, { counter: 7 });
    const session = await service.finishAuthentication(assertion as any);
    assert.equal(verifyAccessToken(session.token).userId, userId);

    const stored = await db.passkeyCredential.findUnique({ where: { credentialId: phoneReg.response.id } });
    assert.equal(stored.counter, 7n);
    assert.ok(stored.publicKey.length > 64, "COSE public key stored as bytes");

    await assert.rejects(service.finishAuthentication(assertion as any), WebAuthnVerificationError, "replay");

    const again = await service.startAuthentication();
    await assert.rejects(
      service.finishAuthentication(phone.assert(again.challenge, phoneReg.credential, { counter: 3 }) as any),
      WebAuthnVerificationError,
      "counter regression"
    );
    assert.equal((await db.passkeyCredential.findUnique({ where: { credentialId: phoneReg.response.id } })).counter, 7n);

    // The second authenticator works independently
    const viaKey = await service.startAuthentication();
    const keySession = await service.finishAuthentication(key.assert(viaKey.challenge, keyReg.credential) as any);
    assert.equal(keySession.user.id, userId);
  });
});
