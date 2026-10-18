/**
 * On-demand ledger reconciliation (issue #261).
 *
 * Usage:
 *   npm run reconcile:ledger -- [--from-ledger N] [--to-ledger N] [--lookback N] [--out DIR] [--no-notify]
 *
 * Prints a Markdown summary and, with --out, writes
 * ledger-reconciliation-<runId>.json and .md to DIR.
 * Exits with code 2 when discrepancies are found, so it can gate CI or cron.
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ledgerReconciliationService,
  reportToJson,
  reportToMarkdown,
} from "../services/financial/ledgerReconciliationService.js";
import { financialAuditLog } from "../services/audit/financialAuditLog.js";
import { prisma } from "../config/db.js";

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function readInt(args: string[], name: string): number | undefined {
  const value = readFlag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const report = await ledgerReconciliationService.reconcile({
    fromLedger: readInt(args, "--from-ledger"),
    toLedger: readInt(args, "--to-ledger"),
    lookbackLedgers: readInt(args, "--lookback"),
    trigger: "cli",
    notify: !args.includes("--no-notify"),
  });

  const markdown = reportToMarkdown(report);
  console.log(markdown);

  const outDir = readFlag(args, "--out");
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    const base = path.join(outDir, `ledger-reconciliation-${report.runId}`);
    await writeFile(`${base}.json`, reportToJson(report));
    await writeFile(`${base}.md`, markdown);
    console.log(`Reports written to ${base}.json and ${base}.md`);
  }

  process.exitCode = report.status === "BALANCED" ? 0 : 2;
}

main()
  .catch((error) => {
    console.error("Ledger reconciliation failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await financialAuditLog.close();
    await prisma.$disconnect();
  });
