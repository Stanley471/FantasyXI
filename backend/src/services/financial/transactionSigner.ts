import {
  FeeBumpTransaction,
  Keypair,
  type Transaction,
} from "@stellar/stellar-sdk";

export type StellarTransaction = Transaction | FeeBumpTransaction;

export interface StellarTransactionSigner {
  publicKey(keyReference: string): string | Promise<string>;
  sign(transaction: StellarTransaction, keyReference: string): Promise<void>;
}

export class LocalSecretTransactionSigner implements StellarTransactionSigner {
  public publicKey(keyReference: string): string {
    return Keypair.fromSecret(keyReference).publicKey();
  }

  public async sign(transaction: StellarTransaction, keyReference: string): Promise<void> {
    transaction.sign(Keypair.fromSecret(keyReference));
  }
}

/** Adapter for KMS/HSM providers that sign Stellar transaction hashes remotely. */
export class RemoteTransactionSigner implements StellarTransactionSigner {
  constructor(
    private readonly resolvePublicKey: (keyId: string) => Promise<string>,
    private readonly signHash: (keyId: string, hash: Buffer) => Promise<Buffer>
  ) {}

  public publicKey(keyId: string): Promise<string> {
    return this.resolvePublicKey(keyId);
  }

  public async sign(transaction: StellarTransaction, keyId: string): Promise<void> {
    const publicKey = await this.resolvePublicKey(keyId);
    const signature = await this.signHash(keyId, Buffer.from(transaction.hash()));
    transaction.addSignature(publicKey, signature.toString("base64"));
  }
}