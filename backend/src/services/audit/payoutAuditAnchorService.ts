import { BaseFee, Horizon, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { prisma } from "../../config/db.js";
import { stellarConfig } from "../../config/stellar.js";
import { GENESIS_HASH, PersistentCryptoAuditLog } from "./cryptoAuditLog.js";

export class PayoutAuditAnchorService {
  private readonly chain: PersistentCryptoAuditLog;

  constructor(private readonly db: any = prisma) {
    this.chain = new PersistentCryptoAuditLog(db);
  }

  async recordSettlement(stellarTxHash: string): Promise<number> {
    const payouts = await this.db.transaction.findMany({
      where: { stellarTxHash, type: { in: ["PRIZE_PAYOUT", "PLATFORM_FEE"] } },
      orderBy: { createdAt: "asc" },
    });
    for (const payout of payouts) {
      await this.chain.append("PAYOUT_DISTRIBUTED", payout.userId, "Payout", payout.id, {
        leagueId: payout.leagueId,
        type: payout.type,
        amount: String(payout.amount),
        asset: payout.asset,
        stellarTxHash: payout.stellarTxHash,
        confirmedAt: payout.confirmedAt?.toISOString() ?? null,
      });
    }
    return payouts.length;
  }

  async anchorCurrentRoot(): Promise<{ anchored: boolean; rootHash: string; txHash?: string }> {
    const head = await this.db.cryptoAuditLogEntry.findFirst({ orderBy: { sequence: "desc" } });
    if (!head) return { anchored: false, rootHash: GENESIS_HASH };
    const prior = await this.db.cryptoAuditLogEntry.findFirst({ where: { action: "PAYOUT_CHAIN_ANCHORED" }, orderBy: { sequence: "desc" } });
    if (prior?.payload?.rootHash === head.hash) return { anchored: false, rootHash: head.hash, txHash: prior.payload.txHash };

    const secret = process.env.STELLAR_AUDIT_ANCHOR_SECRET;
    if (!secret) return { anchored: false, rootHash: head.hash };
    const keypair = Keypair.fromSecret(secret);
    const server = new Horizon.Server(stellarConfig.horizonUrl);
    const account = await server.loadAccount(keypair.publicKey());
    const transaction = new TransactionBuilder(account, { fee: BaseFee, networkPassphrase: stellarConfig.networkPassphrase })
      .addMemo(Memo.hash(Buffer.from(head.hash, "hex")))
      .addOperation(Operation.manageData({ name: "fantasyxi_payout_audit", value: Buffer.from(head.hash, "hex") }))
      .setTimeout(60)
      .build();
    transaction.sign(keypair);
    const submitted = await server.submitTransaction(transaction);
    await this.chain.append("PAYOUT_CHAIN_ANCHORED", "system", "PayoutAuditAnchor", submitted.hash, {
      rootHash: head.hash,
      anchorSequence: head.sequence,
      txHash: submitted.hash,
      ledger: submitted.ledger,
      network: stellarConfig.network,
    });
    return { anchored: true, rootHash: head.hash, txHash: submitted.hash };
  }

  async verify(entryId?: string) {
    const chain = await this.chain.verify();
    const entry = entryId ? await this.db.cryptoAuditLogEntry.findUnique({ where: { id: entryId } }) : null;
    const anchors = await this.db.cryptoAuditLogEntry.findMany({ where: { action: "PAYOUT_CHAIN_ANCHORED" }, orderBy: { sequence: "desc" }, take: 20 });
    const anchor = entry ? anchors.find((item: any) => Number(item.payload?.anchorSequence ?? 0) >= entry.sequence) : anchors[0];
    let onChainConfirmed = false;
    let memoMatches = false;
    if (anchor?.payload?.txHash) {
      try {
        const transaction = await new Horizon.Server(stellarConfig.horizonUrl).transactions().transaction(anchor.payload.txHash).call();
        onChainConfirmed = transaction.successful;
        memoMatches = transaction.memo === Buffer.from(anchor.payload.rootHash, "hex").toString("base64");
      } catch {
        onChainConfirmed = false;
      }
    }
    return {
      valid: chain.valid && (!entryId || Boolean(entry)) && (!anchor || (onChainConfirmed && memoMatches)),
      chain,
      entry: entry ? { id: entry.id, sequence: entry.sequence, hash: entry.hash } : null,
      anchor: anchor ? { rootHash: anchor.payload.rootHash, txHash: anchor.payload.txHash, anchorSequence: anchor.payload.anchorSequence, onChainConfirmed, memoMatches } : null,
    };
  }
}

export const payoutAuditAnchorService = new PayoutAuditAnchorService();
