import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  MultiChainAccountLinkerService,
  MultiChainWalletError,
  createEvmTestWallet,
  createZcashTestWallet,
  parseChallengeFields,
} from "../services/auth/multiChainAccountLinkerService.js";
import { signStellarEd25519Message } from "../services/financial/micropaymentChannelService.js";

describe("Crypto Wallet Connection Recovery & Multi-Chain Account Linker (Issue #426)", () => {
  it("links EVM, Stellar, and Zcash addresses using EIP-4361 / SEP-0010 signed challenges containing timestamp and nonce", () => {
    const service = new MultiChainAccountLinkerService({
      domain: "fantasyxi.app",
      uri: "https://fantasyxi.app/profile",
    });
    const userId = "user-multichain-1";

    // 1. EVM (EIP-4361)
    const evmWallet = createEvmTestWallet();
    const evmChallenge = service.issueLinkChallenge({
      userId,
      chain: "EVM",
      address: evmWallet.address,
      networkId: "eip155:1",
    });

    assert.equal(evmChallenge.standard, "EIP-4361");
    const evmFields = parseChallengeFields(evmChallenge.message);
    assert.equal(evmFields.nonce, evmChallenge.nonce);
    assert.equal(evmFields.issuedAt, evmChallenge.issuedAt);
    assert.match(evmChallenge.message, /fantasyxi\.app wants you to sign in with your EVM account/);

    const evmSig = evmWallet.signMessage(evmChallenge.message);
    const linkedEvm = service.verifyAndLinkWallet({
      userId,
      chain: "EVM",
      address: evmWallet.address,
      message: evmChallenge.message,
      signature: evmSig,
      providerName: "MetaMask",
      label: "Main EVM Vault",
    });

    assert.equal(linkedEvm.chain, "EVM");
    assert.equal(linkedEvm.label, "Main EVM Vault");
    assert.equal(linkedEvm.isPrimary, true);

    // 2. Stellar (SEP-0010)
    const stellarKp = Keypair.random();
    const stellarChallenge = service.issueLinkChallenge({
      userId,
      chain: "STELLAR",
      address: stellarKp.publicKey(),
      networkId: "TESTNET",
    });

    assert.equal(stellarChallenge.standard, "SEP-0010");
    const stellarFields = parseChallengeFields(stellarChallenge.message);
    assert.equal(stellarFields.nonce, stellarChallenge.nonce);
    assert.equal(stellarFields.issuedAt, stellarChallenge.issuedAt);
    assert.match(stellarChallenge.message, /SEP-0010 Stellar Web Authentication/);

    const stellarSig = signStellarEd25519Message(stellarKp, stellarChallenge.message);
    const linkedStellar = service.verifyAndLinkWallet({
      userId,
      chain: "STELLAR",
      address: stellarKp.publicKey(),
      message: stellarChallenge.message,
      signature: stellarSig,
      providerName: "Freighter",
      label: "Soroban Escrow Signer",
    });

    assert.equal(linkedStellar.chain, "STELLAR");
    assert.equal(linkedStellar.label, "Soroban Escrow Signer");
    assert.equal(linkedStellar.isPrimary, false);

    // 3. Zcash (EIP-4361 structured challenge)
    const zcashWallet = createZcashTestWallet();
    const zcashChallenge = service.issueLinkChallenge({
      userId,
      chain: "ZCASH",
      address: zcashWallet.address,
      networkId: "mainnet",
    });

    assert.equal(zcashChallenge.standard, "EIP-4361");
    const zcashSig = zcashWallet.signMessage(zcashChallenge.message);
    const linkedZcash = service.verifyAndLinkWallet({
      userId,
      chain: "ZCASH",
      address: zcashWallet.address,
      message: zcashChallenge.message,
      signature: zcashSig,
      providerName: "Zashi",
      label: "Shielded Zcash Pool",
    });

    assert.equal(linkedZcash.chain, "ZCASH");
    assert.equal(linkedZcash.label, "Shielded Zcash Pool");

    const allWallets = service.listUserWallets(userId);
    assert.equal(allWallets.length, 3);
  });

  it("blocks replay attacks with previously signed challenge messages or consumed nonces", () => {
    const service = new MultiChainAccountLinkerService();
    const userId = "user-replay-test";
    const stellarKp = Keypair.random();

    const challenge = service.issueLinkChallenge({
      userId,
      chain: "STELLAR",
      address: stellarKp.publicKey(),
    });
    const signature = signStellarEd25519Message(stellarKp, challenge.message);

    // First verification succeeds
    service.verifyAndLinkWallet({
      userId,
      chain: "STELLAR",
      address: stellarKp.publicKey(),
      message: challenge.message,
      signature,
    });

    // Replaying the exact same signed challenge message must be blocked
    assert.throws(
      () =>
        service.verifyAndLinkWallet({
          userId,
          chain: "STELLAR",
          address: stellarKp.publicKey(),
          message: challenge.message,
          signature,
        }),
      (err: unknown) =>
        err instanceof MultiChainWalletError && err.code === "CHALLENGE_REPLAYED"
    );

    // Even after unlinking the wallet, replaying the old signed challenge is still blocked
    const wallets = service.listUserWallets(userId);
    service.unlinkWallet(userId, wallets[0].id);

    assert.throws(
      () =>
        service.verifyAndLinkWallet({
          userId,
          chain: "STELLAR",
          address: stellarKp.publicKey(),
          message: challenge.message,
          signature,
        }),
      (err: unknown) =>
        err instanceof MultiChainWalletError && err.code === "CHALLENGE_REPLAYED"
    );
  });

  it("prevents linking an address already claimed by another active user", () => {
    const service = new MultiChainAccountLinkerService();
    const evmWallet = createEvmTestWallet();

    // User A links the EVM address
    const challengeA = service.issueLinkChallenge({
      userId: "user-A",
      chain: "EVM",
      address: evmWallet.address,
    });
    service.verifyAndLinkWallet({
      userId: "user-A",
      chain: "EVM",
      address: evmWallet.address,
      message: challengeA.message,
      signature: evmWallet.signMessage(challengeA.message),
    });

    // User B attempts to request a challenge or link the same address (case-insensitive)
    assert.throws(
      () =>
        service.issueLinkChallenge({
          userId: "user-B",
          chain: "EVM",
          address: evmWallet.address.toUpperCase().replace(/^0X/, "0x"),
        }),
      (err: unknown) =>
        err instanceof MultiChainWalletError &&
        err.code === "ADDRESS_ALREADY_CLAIMED" &&
        err.statusCode === 409
    );
  });

  it("rejects expired challenges and supports renaming and unlinking secondary addresses", () => {
    const service = new MultiChainAccountLinkerService({ challengeTtlMs: 60_000 });
    const userId = "user-manage-1";
    const kp1 = Keypair.random();
    const kp2 = Keypair.random();
    const t0 = 1_700_000_000_000;

    // Issue challenge at t0, attempt verification after expiry (t0 + 120_000)
    const expiredChal = service.issueLinkChallenge(
      { userId, chain: "STELLAR", address: kp1.publicKey() },
      t0
    );
    const expiredSig = signStellarEd25519Message(kp1, expiredChal.message);

    assert.throws(
      () =>
        service.verifyAndLinkWallet(
          {
            userId,
            chain: "STELLAR",
            address: kp1.publicKey(),
            message: expiredChal.message,
            signature: expiredSig,
          },
          t0 + 120_000
        ),
      (err: unknown) =>
        err instanceof MultiChainWalletError && err.code === "CHALLENGE_EXPIRED"
    );

    // Link two valid wallets
    const c1 = service.issueLinkChallenge(
      { userId, chain: "STELLAR", address: kp1.publicKey() },
      t0
    );
    const w1 = service.verifyAndLinkWallet(
      {
        userId,
        chain: "STELLAR",
        address: kp1.publicKey(),
        message: c1.message,
        signature: signStellarEd25519Message(kp1, c1.message),
        label: "Primary Freighter",
      },
      t0 + 1_000
    );

    const c2 = service.issueLinkChallenge(
      { userId, chain: "STELLAR", address: kp2.publicKey() },
      t0
    );
    const w2 = service.verifyAndLinkWallet(
      {
        userId,
        chain: "STELLAR",
        address: kp2.publicKey(),
        message: c2.message,
        signature: signStellarEd25519Message(kp2, c2.message),
        label: "Backup Ledger",
      },
      t0 + 2_000
    );

    // Rename secondary wallet
    const renamed = service.renameWallet(userId, w2.id, "Hardware Vault");
    assert.equal(renamed.label, "Hardware Vault");

    // Another user cannot rename or unlink
    assert.throws(
      () => service.renameWallet("other-user", w2.id, "Hijack"),
      (err: unknown) => err instanceof MultiChainWalletError && err.code === "FORBIDDEN"
    );

    // Unlink secondary wallet
    service.unlinkWallet(userId, w2.id);
    const remaining = service.listUserWallets(userId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, w1.id);
  });
});
