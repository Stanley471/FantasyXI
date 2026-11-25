import { prisma } from "../../config/db.js";
import { adminAlertNotifier } from "../notifications/adminAlertNotifier.js";
import { financialMerkle, verifyFinancialRows, type ChainedFinancialRow } from "./financialMerkle.js";

interface Entry extends ChainedFinancialRow { audit_id: string; transaction_id: string | null; captured_at: Date }
interface Root { hour: Date; first_sequence: bigint; last_sequence: bigint; entry_count: number; root: string; receipt: string }
export interface PublicRoot { hour: string; firstSequence: string; lastSequence: string; entryCount: number; root: string }
export interface FinancialRootPublisher {
  publish(root: PublicRoot): Promise<string>;
  read(hour: string): Promise<PublicRoot>;
  list(): Promise<PublicRoot[]>;
}
const publicRoot = (root: Root): PublicRoot => ({ hour: root.hour.toISOString(), firstSequence: String(root.first_sequence), lastSequence: String(root.last_sequence), entryCount: root.entry_count, root: root.root });

/** Configured independent public log: PUT/GET {base}/{ISO hour}, idempotent by hour. */
export class HttpFinancialRootPublisher implements FinancialRootPublisher {
  private url(hour: string) {
    const base = new URL(process.env.FINANCIAL_AUDIT_PUBLIC_LOG_URL ?? "");
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Independent HTTPS audit log must be configured");
    return base.href.replace(/\/$/, "") + "/" + encodeURIComponent(hour);
  }
  async publish(root: PublicRoot) {
    const url = this.url(root.hour);
    const token=process.env.FINANCIAL_AUDIT_PUBLIC_LOG_TOKEN;
    if(!token) throw new Error("Audit publication credential is required");
    const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", "Authorization":`Bearer ${token}`, "Idempotency-Key": `financial-audit:${root.hour}` }, body: JSON.stringify(root), signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error("Audit root publication failed");
    const actual = await this.read(root.hour);
    if (JSON.stringify(actual) !== JSON.stringify(root)) throw new Error("Published root does not match");
    return url;
  }
  async read(hour: string): Promise<PublicRoot> {
    const response = await fetch(this.url(hour), { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error("Independent root unavailable");
    const value = await response.json() as PublicRoot;
    return { hour: value.hour, firstSequence: value.firstSequence, lastSequence: value.lastSequence, entryCount: value.entryCount, root: value.root };
  }
  async list(): Promise<PublicRoot[]> {
    const base=this.url("").replace(/\/$/,"");
    const response=await fetch(base,{signal:AbortSignal.timeout(5000),redirect:"error"});
    if(!response.ok) throw new Error("Independent root inventory unavailable");
    const roots:unknown=await response.json();
    if(!Array.isArray(roots) || roots.some(root=>typeof root?.hour!=="string" || !Number.isFinite(Date.parse(root.hour)) || !/^[a-f0-9]{64}$/.test(root?.root) || !/^\d+$/.test(root?.firstSequence) || !/^\d+$/.test(root?.lastSequence) || !Number.isSafeInteger(root?.entryCount) || root.entryCount<1)) throw new Error("Invalid independent root inventory");
    return roots;
  }
}

export class FinancialMerkleService {
  constructor(private readonly db = prisma, private readonly publisher: FinancialRootPublisher = new HttpFinancialRootPublisher(),
    private readonly alert = () => adminAlertNotifier.notify({title:"Financial audit tampering detected",severity:"critical",text:"Financial audit source, chain or independently published root failed verification."})) {}
  async entries(database: Pick<typeof prisma, "$queryRaw"> = this.db): Promise<Entry[]> {
    return database.$queryRaw<Entry[]>`SELECT m.*,to_jsonb(s)::text AS source_text FROM financial_merkle_entries m LEFT JOIN financial_audit_logs s ON s.id=m.audit_id ORDER BY m.sequence`;
  }
  async verify(): Promise<Entry[]> {
    // Share the capture lock while reading related tables. ReadCommitted sees
    // writers that committed while we waited; network publication happens after
    // releasing the lock so it cannot stall transaction capture.
    const {rows, roots, sources, mismatches} = await this.db.$transaction(async database => {
      await database.$executeRaw`SELECT pg_advisory_xact_lock(45119001)`;
      const rows = await this.entries(database);
      const roots = await database.$queryRaw<Root[]>`SELECT * FROM financial_merkle_roots ORDER BY hour`;
      const sources = await database.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM financial_audit_logs`;
      const mismatches = await database.$queryRaw<{ count: bigint }[]>`
        WITH latest AS (
          SELECT DISTINCT ON (transaction_id) transaction_id,
            payload_text::jsonb->'metadata'->'transaction_snapshot' AS snapshot
          FROM financial_merkle_entries
          WHERE payload_text::jsonb->'metadata'->'transaction_snapshot' IS NOT NULL
          ORDER BY transaction_id, sequence DESC
        ) SELECT count(*) AS count FROM latest FULL JOIN transactions t ON t.id=latest.transaction_id
          WHERE latest.snapshot IS DISTINCT FROM to_jsonb(t)`;
      return {rows, roots, sources, mismatches};
    }, {isolationLevel: "ReadCommitted"});
    let valid = verifyFinancialRows(rows);
    if (sources[0].count !== BigInt(rows.length) || mismatches[0].count !== 0n) valid = false;
    if(!valid) { await this.alert(); throw new Error("Financial audit integrity verification failed"); }
    // Inventory comes from outside this database, so deleting its checkpoint
    // metadata cannot hide the truncation of an already published suffix.
    const independent=await this.publisher.list();
    for(const item of independent) {
      if(roots.some(root=>root.hour.toISOString()===item.hour)) continue;
      const block=rows.filter(row=>row.sequence>=BigInt(item.firstSequence) && row.sequence<=BigInt(item.lastSequence));
      if(!block.length || block.length!==item.entryCount || String(block[0].sequence)!==item.firstSequence || String(block.at(-1)!.sequence)!==item.lastSequence || financialMerkle(block.map(row=>row.hash)).root!==item.root) { valid=false; continue; }
      // A crash may follow the independent PUT but precede the local INSERT.
      // Recover metadata only when the complete surviving evidence reproduces it.
      const recovered:Root={hour:new Date(item.hour),first_sequence:BigInt(item.firstSequence),last_sequence:BigInt(item.lastSequence),entry_count:item.entryCount,root:item.root,receipt:`independent-log:${item.hour}`};
      await this.db.$executeRaw`INSERT INTO financial_merkle_roots(hour,first_sequence,last_sequence,entry_count,root,receipt)
        VALUES(${recovered.hour},${recovered.first_sequence},${recovered.last_sequence},${recovered.entry_count},${recovered.root},${recovered.receipt}) ON CONFLICT(hour) DO NOTHING`;
      roots.push(recovered);
    }
    for (const root of roots) {
      const block = rows.filter(row => row.sequence >= root.first_sequence && row.sequence <= root.last_sequence);
      if (block.length !== root.entry_count || !block.length || financialMerkle(block.map(row => row.hash)).root !== root.root || JSON.stringify(await this.publisher.read(root.hour.toISOString())) !== JSON.stringify(publicRoot(root))) valid = false;
    }
    if (!valid) {
      await this.alert();
      throw new Error("Financial audit integrity verification failed");
    }
    return rows;
  }
  async publishClosedHours(now = new Date()) {
    const rows = await this.verify();
    const boundary = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    const hours = new Map<number, Entry[]>();
    for (const row of rows) {
      const hour = Math.floor(row.captured_at.getTime() / 3_600_000) * 3_600_000;
      if (hour < boundary) { const block = hours.get(hour) ?? []; block.push(row); hours.set(hour, block); }
    }
    for (const [hour, block] of hours) {
      const existing = await this.db.$queryRaw<Root[]>`SELECT * FROM financial_merkle_roots WHERE hour=${new Date(hour)}`;
      if (existing.length) continue;
      const root = financialMerkle(block.map(row => row.hash)).root;
      const data: PublicRoot = { hour: new Date(hour).toISOString(), firstSequence: String(block[0].sequence), lastSequence: String(block.at(-1)!.sequence), entryCount: block.length, root };
      const receipt = await this.publisher.publish(data);
      await this.db.$executeRaw`INSERT INTO financial_merkle_roots(hour,first_sequence,last_sequence,entry_count,root,receipt)
        VALUES (${new Date(hour)},${block[0].sequence},${block.at(-1)!.sequence},${block.length},${root},${receipt}) ON CONFLICT(hour) DO NOTHING`;
    }
  }
  async proof(transactionId: string) {
    const rows = await this.verify();
    const result = [];
    for (const row of rows.filter(row => row.transaction_id === transactionId)) {
      const roots = await this.db.$queryRaw<Root[]>`SELECT * FROM financial_merkle_roots WHERE first_sequence <= ${row.sequence} AND last_sequence >= ${row.sequence}`;
      if (!roots.length) continue;
      const root = roots[0]; const block = rows.filter(entry => entry.sequence >= root.first_sequence && entry.sequence <= root.last_sequence);
      result.push({ auditId: row.audit_id, hash: row.hash, ...financialMerkle(block.map(entry => entry.hash), block.indexOf(row)), publication: publicRoot(root), receipt: root.receipt });
    }
    return result;
  }
}
export const financialMerkleService = new FinancialMerkleService();
