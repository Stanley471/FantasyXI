import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";
import {
  LocalSecretTransactionSigner,
  RemoteTransactionSigner,
} from "../services/financial/transactionSigner.js";

function transaction() {
  const source = Keypair.random();
  return TransactionBuilder.fromXDR(
    new TransactionBuilder(new Account(source.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
      .setTimeout(30)
      .build()
      .toXDR(),
    Networks.TESTNET
  );
}

describe("Stellar transaction signing adapters", () => {
  it("signs locally without exposing signing logic to callers", async () => {
    const keypair = Keypair.random();
    const signer = new LocalSecretTransactionSigner();
    const tx = transaction();

    await signer.sign(tx, keypair.secret());

    assert.equal(await signer.publicKey(keypair.secret()), keypair.publicKey());
    assert.equal(tx.signatures.length, 1);
  });

  it("attaches a signature returned by a remote key service", async () => {
    const keypair = Keypair.random();
    const signer = new RemoteTransactionSigner(
      async (keyId) => keyId === "kms-key" ? keypair.publicKey() : "",
      async (_keyId, hash) => Buffer.from(keypair.sign(hash))
    );
    const tx = transaction();

    await signer.sign(tx, "kms-key");

    assert.equal(tx.signatures.length, 1);
    assert.equal(await signer.publicKey("kms-key"), keypair.publicKey());
  });

  it("submits an outer fee-bump transaction when a sponsor is configured", async () => {
    const source = Keypair.random();
    const sponsor = Keypair.random();
    let submitted: any;
    const server = {
      sendTransaction: async (tx: any) => {
        submitted = tx;
        return { status: "PENDING", hash: "a".repeat(64) };
      },
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
    } as any;
    const client = new SorobanContractClient({
      server,
      escrowContractId: "C" + "A".repeat(55),
      feeBumpFeeSource: sponsor.secret(),
      pollIntervalMs: 0,
    });
    const inner = new TransactionBuilder(new Account(source.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
      .setTimeout(30)
      .build();
    inner.sign(source);

    const result = await (client as any).sendAndPoll(inner);

    assert.equal(result.success, true);
    assert.ok(submitted.constructor.name.includes("FeeBump"));
    assert.equal(submitted.signatures.length, 1);
  });
});