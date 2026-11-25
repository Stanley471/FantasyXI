/**
 * pg_dump wrapper for the automated backup pipeline (issue #504).
 *
 * Uses pg_dump's custom format (`-Fc`): a single compressed, pg_restore-able
 * file. pg_dump takes a consistent MVCC snapshot and only holds brief
 * ACCESS SHARE locks per table while reading its schema — it never blocks
 * concurrent INSERT/UPDATE/DELETE, so this runs safely against a live,
 * actively-written production database.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PgDumpOptions {
  /** Postgres connection string; defaults to process.env.DATABASE_URL. */
  connectionString?: string;
  /** Destination path for the dump file. */
  outputPath: string;
  /** Overridable for tests; defaults to the real `pg_dump` binary. */
  pgDumpPath?: string;
}

export async function runPgDump(options: PgDumpOptions): Promise<{ outputPath: string }> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("runPgDump requires DATABASE_URL (or options.connectionString) to be set");
  }

  await execFileAsync(options.pgDumpPath ?? "pg_dump", [
    connectionString,
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    `--file=${options.outputPath}`,
  ]);

  return { outputPath: options.outputPath };
}
