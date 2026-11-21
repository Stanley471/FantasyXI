/**
 * S3/R2 upload + retention for encrypted database backups (issue #504).
 *
 * Uploads are a single `PutObjectCommand` (never multipart), so S3's
 * response ETag is a plain MD5 of the body — comparing it against a locally
 * computed MD5 is a correct, zero-extra-round-trip integrity check. The
 * backup's SHA-256 is also stored as object metadata for later verification
 * by restore tooling.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

export class BackupIntegrityError extends Error {
  constructor(expectedMd5: string, actualETag: string | undefined) {
    super(
      `Backup upload integrity check failed: expected MD5 ${expectedMd5}, S3 returned ETag ${actualETag ?? "<none>"}`
    );
    this.name = "BackupIntegrityError";
  }
}

export interface UploadBackupResult {
  key: string;
  md5: string;
  sha256: string;
  sizeBytes: number;
}

export interface S3BackupUploaderOptions {
  bucket: string;
  /** e.g. for Cloudflare R2: https://<account-id>.r2.cloudflarestorage.com */
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  client?: S3Client;
}

export class S3BackupUploader {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(options: S3BackupUploaderOptions) {
    this.bucket = options.bucket;
    this.client =
      options.client ??
      new S3Client({
        region: options.region || "auto",
        endpoint: options.endpoint,
        credentials:
          options.accessKeyId && options.secretAccessKey
            ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
            : undefined,
      } satisfies S3ClientConfig);
  }

  /**
   * Uploads a single file and verifies the upload by comparing the response
   * ETag against a locally computed MD5. Throws {@link BackupIntegrityError}
   * on mismatch so a corrupted upload never looks like a successful backup.
   */
  public async uploadFile(filePath: string, key: string): Promise<UploadBackupResult> {
    const body = await readFile(filePath);
    const md5 = createHash("md5").update(body).digest("hex");
    const sha256 = createHash("sha256").update(body).digest("hex");

    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        Metadata: { sha256 },
      })
    );

    const actualETag = result.ETag?.replace(/"/g, "");
    if (actualETag !== md5) {
      throw new BackupIntegrityError(md5, result.ETag);
    }

    return { key, md5, sha256, sizeBytes: body.length };
  }

  /**
   * Deletes every object under `prefix` older than `retentionDays`, enforcing
   * the 30-day retention policy without relying on the bucket's own
   * lifecycle configuration (which R2 may not fully support).
   */
  public async pruneOlderThan(prefix: string, retentionDays: number): Promise<string[]> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const deleted: string[] = [];
    let continuationToken: string | undefined;

    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      for (const object of page.Contents ?? []) {
        if (!object.Key || !object.LastModified) continue;
        if (object.LastModified.getTime() < cutoff) {
          await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: object.Key }));
          deleted.push(object.Key);
        }
      }

      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    return deleted;
  }
}

