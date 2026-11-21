import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { encryptFile, decryptFile } from "../scripts/backup/encryptFile.js";
import { S3BackupUploader, BackupIntegrityError } from "../scripts/backup/s3BackupUploader.js";
import { pingBackupHealthcheck } from "../scripts/backup/healthPing.js";
import { runPgDump } from "../scripts/backup/pgDump.js";
import { runDatabaseBackup } from "../scripts/runDatabaseBackup.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "backup-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("encryptFile / decryptFile (issue #504)", () => {
  it("round-trips arbitrary content through AES-256-GCM", async () => {
    const plaintext = "pg_dump custom-format backup content\n".repeat(500);
    const inputPath = path.join(workDir, "plain.dump");
    const encryptedPath = path.join(workDir, "plain.dump.enc");
    await writeFile(inputPath, plaintext);

    const result = await encryptFile(inputPath, encryptedPath, "correct-passphrase");
    const decrypted = await decryptFile(encryptedPath, "correct-passphrase");

    assert.equal(decrypted.toString("utf8"), plaintext);
    assert.equal(result.sizeBytes, (await readFile(encryptedPath)).length);
  });

  it("reports the SHA-256 of the encrypted output, not the plaintext", async () => {
    const inputPath = path.join(workDir, "plain.dump");
    const encryptedPath = path.join(workDir, "plain.dump.enc");
    await writeFile(inputPath, "some backup bytes");

    const result = await encryptFile(inputPath, encryptedPath, "passphrase");
    const actualSha256 = createHash("sha256").update(await readFile(encryptedPath)).digest("hex");
    assert.equal(result.sha256, actualSha256);
  });

  it("fails to decrypt with the wrong passphrase (auth tag mismatch)", async () => {
    const inputPath = path.join(workDir, "plain.dump");
    const encryptedPath = path.join(workDir, "plain.dump.enc");
    await writeFile(inputPath, "secret backup bytes");
    await encryptFile(inputPath, encryptedPath, "right-key");

    await assert.rejects(() => decryptFile(encryptedPath, "wrong-key"));
  });
});

describe("S3BackupUploader (issue #504)", () => {
  it("uploads a file and verifies integrity via the ETag/MD5 match", async () => {
    const filePath = path.join(workDir, "backup.dump.enc");
    const content = Buffer.from("encrypted backup payload");
    await writeFile(filePath, content);
    const expectedMd5 = createHash("md5").update(content).digest("hex");

    const sentCommands: unknown[] = [];
    const mockClient = {
      send: async (command: unknown) => {
        sentCommands.push(command);
        if (command instanceof PutObjectCommand) {
          return { ETag: `"${expectedMd5}"` };
        }
        throw new Error("unexpected command");
      },
    };

    const uploader = new S3BackupUploader({ bucket: "test-bucket", client: mockClient as any });
    const result = await uploader.uploadFile(filePath, "database-backups/test.dump.enc");

    assert.equal(result.md5, expectedMd5);
    assert.equal(result.key, "database-backups/test.dump.enc");
    assert.equal(sentCommands.length, 1);
  });

  it("throws BackupIntegrityError when the returned ETag does not match the local MD5", async () => {
    const filePath = path.join(workDir, "backup.dump.enc");
    await writeFile(filePath, "payload");

    const mockClient = {
      send: async (command: unknown) => {
        if (command instanceof PutObjectCommand) {
          return { ETag: '"0000000000000000000000000000000"' };
        }
        throw new Error("unexpected command");
      },
    };

    const uploader = new S3BackupUploader({ bucket: "test-bucket", client: mockClient as any });
    await assert.rejects(
      () => uploader.uploadFile(filePath, "database-backups/test.dump.enc"),
      BackupIntegrityError
    );
  });

  it("prunes only objects older than the retention window, across paginated listings", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const allObjects = [
      { Key: "database-backups/old-1.dump.enc", LastModified: new Date(now - 45 * day) },
      { Key: "database-backups/old-2.dump.enc", LastModified: new Date(now - 31 * day) },
      { Key: "database-backups/fresh-1.dump.enc", LastModified: new Date(now - 10 * day) },
      { Key: "database-backups/fresh-2.dump.enc", LastModified: new Date(now - 1 * day) },
    ];
    const deletedKeys: string[] = [];

    const mockClient = {
      send: async (command: unknown) => {
        if (command instanceof ListObjectsV2Command) {
          const token = command.input.ContinuationToken;
          if (!token) {
            return { Contents: allObjects.slice(0, 2), IsTruncated: true, NextContinuationToken: "page-2" };
          }
          assert.equal(token, "page-2");
          return { Contents: allObjects.slice(2), IsTruncated: false };
        }
        if (command instanceof DeleteObjectCommand) {
          deletedKeys.push(command.input.Key!);
          return {};
        }
        throw new Error("unexpected command");
      },
    };

    const uploader = new S3BackupUploader({ bucket: "test-bucket", client: mockClient as any });
    const pruned = await uploader.pruneOlderThan("database-backups/", 30);

    assert.deepEqual(pruned.sort(), ["old-1", "old-2"].map((n) => `database-backups/${n}.dump.enc`).sort());
    assert.deepEqual(deletedKeys.sort(), pruned.sort());
  });
});

describe("pingBackupHealthcheck (issue #504)", () => {
  it("does nothing when no URL is configured", async () => {
    let called = false;
    await pingBackupHealthcheck(undefined, (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch);
    assert.equal(called, false);
  });

  it("GETs the configured URL on success", async () => {
    let requestedUrl: string | undefined;
    await pingBackupHealthcheck("https://hc-ping.com/abc123", (async (url: any) => {
      requestedUrl = String(url);
      return new Response(null, { status: 200 });
    }) as typeof fetch);
    assert.equal(requestedUrl, "https://hc-ping.com/abc123");
  });

  it("never throws, even when the ping request itself fails", async () => {
    await assert.doesNotReject(() =>
      pingBackupHealthcheck("https://hc-ping.com/abc123", (async () => {
        throw new Error("network down");
      }) as typeof fetch)
    );
  });

  it("never throws on a non-2xx response", async () => {
    await assert.doesNotReject(() =>
      pingBackupHealthcheck("https://hc-ping.com/abc123", (async () => new Response(null, { status: 500 })) as typeof fetch)
    );
  });
});

describe("runPgDump (issue #504)", () => {
  it("invokes pg_dump with custom format and writes the output file", async () => {
    // Stand-in for the real `pg_dump` binary: a tiny Node script that just
    // proves it received the connection string, --format=custom and --file
    // arguments, and writes a dummy dump file there.
    const fakePgDumpPath = path.join(workDir, "fake-pg-dump.cjs");
    await writeFile(
      fakePgDumpPath,
      `#!/usr/bin/env node
      const fs = require("fs");
      const args = process.argv.slice(2);
      if (args[0] !== "postgres://fake") throw new Error("missing connection string");
      if (!args.includes("--format=custom")) throw new Error("missing --format=custom");
      const fileArg = args.find((a) => a.startsWith("--file="));
      if (!fileArg) throw new Error("missing --file=");
      fs.writeFileSync(fileArg.slice("--file=".length), "FAKE PG_DUMP OUTPUT");
      `
    );
    await chmod(fakePgDumpPath, 0o755);

    const outputPath = path.join(workDir, "backup.dump");
    const result = await runPgDump({
      connectionString: "postgres://fake",
      outputPath,
      pgDumpPath: fakePgDumpPath,
    });

    assert.equal(result.outputPath, outputPath);
    assert.equal(await readFile(outputPath, "utf8"), "FAKE PG_DUMP OUTPUT");
  });

  it("rejects when no connection string is configured", async () => {
    const originalUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await assert.rejects(() => runPgDump({ outputPath: path.join(workDir, "x.dump") }));
    } finally {
      if (originalUrl !== undefined) process.env.DATABASE_URL = originalUrl;
    }
  });
});

describe("runDatabaseBackup orchestration (issue #504) — mock S3 bucket", () => {
  it("runs pg_dump, encrypts, uploads to the mocked bucket, prunes old backups and pings health check", async () => {
    const fakePgDumpScript = path.join(workDir, "fake-pg-dump.cjs");
    await writeFile(
      fakePgDumpScript,
      `#!/usr/bin/env node
      const fs = require("fs");
      const args = process.argv.slice(2);
      const fileArg = args.find((a) => a.startsWith("--file="));
      fs.writeFileSync(fileArg.slice("--file=".length), "FAKE PG_DUMP OUTPUT FOR ORCHESTRATION TEST");
      `
    );
    await chmod(fakePgDumpScript, 0o755);

    const uploadedObjects: Array<{ key: string; body: Buffer }> = [];
    const mockClient = {
      send: async (command: unknown) => {
        if (command instanceof PutObjectCommand) {
          const body = command.input.Body as Buffer;
          uploadedObjects.push({ key: command.input.Key!, body });
          const md5 = createHash("md5").update(body).digest("hex");
          return { ETag: `"${md5}"` };
        }
        if (command instanceof ListObjectsV2Command) {
          return { Contents: [], IsTruncated: false };
        }
        throw new Error("unexpected command");
      },
    };

    const originalEncryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
    process.env.BACKUP_ENCRYPTION_KEY = "test-encryption-passphrase";
    process.env.DATABASE_URL = "postgres://fake";

    const uploader = new S3BackupUploader({ bucket: "mock-bucket", client: mockClient as any });

    try {
      const result = await runDatabaseBackup({
        now: new Date("2026-11-21T03:00:00.000Z"),
        pgDumpPath: fakePgDumpScript,
        uploader,
      });

      assert.match(result.key, /^database-backups\/fantasyxi-2026-11-21T03-00-00-000Z\.dump\.enc$/);
      assert.equal(uploadedObjects.length, 1);
      assert.equal(uploadedObjects[0].key, result.key);

      const decrypted = await decryptFromBuffer(uploadedObjects[0].body, "test-encryption-passphrase");
      assert.equal(decrypted, "FAKE PG_DUMP OUTPUT FOR ORCHESTRATION TEST");
      assert.deepEqual(result.pruned, []);
    } finally {
      if (originalEncryptionKey !== undefined) {
        process.env.BACKUP_ENCRYPTION_KEY = originalEncryptionKey;
      } else {
        delete process.env.BACKUP_ENCRYPTION_KEY;
      }
      delete process.env.DATABASE_URL;
    }
  });
});

async function decryptFromBuffer(buffer: Buffer, secret: string): Promise<string> {
  const tmpPath = path.join(workDir, "roundtrip.enc");
  await writeFile(tmpPath, buffer);
  const plain = await decryptFile(tmpPath, secret);
  return plain.toString("utf8");
}
