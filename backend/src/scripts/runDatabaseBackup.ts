/**
 * Automated backup: pg_dump (custom format) -> encrypt -> upload to S3/R2
 * -> prune backups older than the retention window -> health ping
 * (issue #504).
 *
 * Usage:
 *   npm run backup:run
 *
 * Required env vars:
 *   DATABASE_URL              Postgres connection string for pg_dump
 *   BACKUP_S3_BUCKET          Destination bucket
 *   BACKUP_ENCRYPTION_KEY     Passphrase used to derive the AES-256-GCM key
 *
 * Optional env vars:
 *   BACKUP_S3_ENDPOINT        S3-compatible endpoint (e.g. Cloudflare R2)
 *   BACKUP_S3_REGION          Defaults to "auto" (fine for R2; set a real
 *                             region for AWS S3)
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or BACKUP_S3_ACCESS_KEY_ID /
 *                             BACKUP_S3_SECRET_ACCESS_KEY
 *   BACKUP_RETENTION_DAYS     Defaults to 30
 *   BACKUP_HEALTHCHECK_URL    Pinged (GET) once the backup is uploaded
 */

import "dotenv/config";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runPgDump } from "./backup/pgDump.js";
import { encryptFile } from "./backup/encryptFile.js";
import { S3BackupUploader } from "./backup/s3BackupUploader.js";
import { pingBackupHealthcheck } from "./backup/healthPing.js";

const BACKUP_PREFIX = "database-backups/";
const DEFAULT_RETENTION_DAYS = 30;

function backupKey(now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${BACKUP_PREFIX}fantasyxi-${timestamp}.dump.enc`;
}

export interface RunDatabaseBackupOptions {
  /** Timestamp embedded in the backup's object key; defaults to now. */
  now?: Date;
  /** Overridable for tests; defaults to the real `pg_dump` binary. */
  pgDumpPath?: string;
  /** Injected for tests; defaults to a real S3BackupUploader built from env vars. */
  uploader?: S3BackupUploader;
}

export async function runDatabaseBackup(options: RunDatabaseBackupOptions = {}): Promise<{
  key: string;
  sha256: string;
  sizeBytes: number;
  pruned: string[];
}> {
  const bucket = process.env.BACKUP_S3_BUCKET;
  const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
  if (!options.uploader && !bucket) throw new Error("BACKUP_S3_BUCKET is required");
  if (!encryptionKey) throw new Error("BACKUP_ENCRYPTION_KEY is required");

  const workDir = await mkdtemp(path.join(tmpdir(), "fantasyxi-backup-"));
  try {
    const dumpPath = path.join(workDir, "backup.dump");
    const encryptedPath = path.join(workDir, "backup.dump.enc");

    await runPgDump({ outputPath: dumpPath, pgDumpPath: options.pgDumpPath });
    const { sizeBytes } = await encryptFile(dumpPath, encryptedPath, encryptionKey);

    const uploader =
      options.uploader ??
      new S3BackupUploader({
        bucket: bucket!,
        endpoint: process.env.BACKUP_S3_ENDPOINT,
        region: process.env.BACKUP_S3_REGION || "auto",
        accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
      });

    const key = backupKey(options.now ?? new Date());
    const uploadResult = await uploader.uploadFile(encryptedPath, key);

    const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
    const pruned = await uploader.pruneOlderThan(BACKUP_PREFIX, retentionDays);

    await pingBackupHealthcheck(process.env.BACKUP_HEALTHCHECK_URL);

    return { key, sha256: uploadResult.sha256, sizeBytes, pruned };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await runDatabaseBackup();
  console.log(
    `[backup] Uploaded ${result.key} (${result.sizeBytes} bytes, sha256=${result.sha256}). Pruned ${result.pruned.length} expired backup(s).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[backup] Backup failed:", err);
    process.exitCode = 1;
  });
}
