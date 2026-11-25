import { createHash } from "node:crypto";

export const FINANCIAL_GENESIS = "0".repeat(64);
export const hashFinancialEntry = (previous: string, payloadText: string) => createHash("sha256").update(previous + payloadText, "utf8").digest("hex");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
const leaf = (hash: string) => {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid entry hash");
  return digest(Buffer.concat([Buffer.from([0]), Buffer.from(hash, "hex")]));
};
const parent = (left: Buffer, right: Buffer) => digest(Buffer.concat([Buffer.from([1]), left, right]));
export interface FinancialProof { index: number; size: number; siblings: string[] }

export function financialMerkle(hashes: string[], index = 0): { root: string; proof: FinancialProof } {
  if (!hashes.length || !Number.isInteger(index) || index < 0 || index >= hashes.length) throw new Error("Invalid proof index");
  let level: Buffer[] = hashes.map(leaf);
  let position = index;
  const siblings: string[] = [];
  while (level.length > 1) {
    siblings.push((level[position ^ 1] ?? level[position]).toString("hex"));
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(parent(level[i], level[i + 1] ?? level[i]));
    level = next; position = Math.floor(position / 2);
  }
  return { root: level[0].toString("hex"), proof: { index, size: hashes.length, siblings } };
}

export function verifyFinancialProof(hash: string, proof: FinancialProof, root: string): boolean {
  if (!Number.isSafeInteger(proof.index) || !Number.isSafeInteger(proof.size) || proof.size < 1 || proof.index < 0 || proof.index >= proof.size || !/^[a-f0-9]{64}$/.test(root)) return false;
  try {
    let value = leaf(hash), position = proof.index, width = proof.size, depth = 0;
    for (const sibling of proof.siblings) {
      if (width <= 1 || !/^[a-f0-9]{64}$/.test(sibling)) return false;
      const other = Buffer.from(sibling, "hex");
      if ((position ^ 1) >= width && !other.equals(value)) return false;
      value = position % 2 ? parent(other, value) : parent(value, other);
      position = Math.floor(position / 2); width = Math.ceil(width / 2); depth++;
    }
    return width === 1 && depth === Math.ceil(Math.log2(proof.size)) && value.toString("hex") === root;
  } catch { return false; }
}

export interface ChainedFinancialRow { sequence: bigint; previous_hash: string; hash: string; payload_text: string; source_text: string | null }
export function verifyFinancialRows(rows: ChainedFinancialRow[]) {
  let previous = FINANCIAL_GENESIS, sequence = 1n;
  for (const row of rows) {
    if (row.sequence !== sequence || row.previous_hash !== previous || row.source_text !== row.payload_text || hashFinancialEntry(previous, row.payload_text) !== row.hash) return false;
    previous = row.hash; sequence++;
  }
  return true;
}
