import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface ExportStorage {
  put(key: string, encrypted: Buffer): Promise<void>;
  link(key: string, expiresAt: Date): Promise<string>;
  delete(key: string): Promise<void>;
}
/** Private cloud bucket. Standard AWS credential provider chain; no keys in jobs. */
export class S3ExportStorage implements ExportStorage {
  private client = new S3Client({ region: process.env.AWS_REGION, requestHandler: { requestTimeout: 10_000 } });
  private bucket() { const bucket = process.env.PRIVACY_EXPORT_BUCKET; if (!bucket) throw new Error("Private export bucket is not configured"); return bucket; }
  async put(key: string, encrypted: Buffer) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket(), Key: key, Body: encrypted, ContentType: "application/json", CacheControl: "no-store", ServerSideEncryption: "AES256" }));
  }
  async link(key: string, expiresAt: Date) {
    const seconds = Math.min(86_400, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    if (seconds <= 0) throw new Error("Export expired");
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket(), Key: key, ResponseContentDisposition: 'attachment; filename="fantasyxi-export.encrypted.json"', ResponseCacheControl: "no-store" }), { expiresIn: seconds });
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: key })); }
}
