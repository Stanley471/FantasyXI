import { randomUUID } from "node:crypto";
import { prisma } from "../../config/db.js";
import { collectUserManifest, eraseUserData } from "./userDataManifest.js";
import { encryptExport, validateExportKey } from "./exportEncryption.js";
import { S3ExportStorage, type ExportStorage } from "./exportStorage.js";
import { sessionRegistryService } from "../auth/sessionRegistryService.js";
import { securityAnomalyLog } from "../security/securityAnomalyLog.js";
import { loginSecurityService } from "../security/loginSecurityService.js";
import { runtimeUserRecords, eraseRuntimeSecurityRecords } from "./privacyRuntimeTables.js";

interface Job { id: string; user_id: string; kind: "EXPORT" | "ERASE"; public_key: string | null; status: string; attempts: number; expires_at: Date; object_key: string | null }
export class PrivacyService {
  constructor(private readonly db: typeof prisma = prisma, private readonly storage: ExportStorage = new S3ExportStorage()) {}
  async request(userId: string, kind: "EXPORT" | "ERASE", key?: unknown) {
    const publicKey = kind === "EXPORT" ? validateExportKey(key) : null;
    const id = randomUUID();
    await this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId},454))`;
      const erased = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM privacy_erased_accounts WHERE user_id=${userId}`;
      if (erased[0].count) throw new Error("Account erased");
      const pending = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM privacy_jobs WHERE user_id=${userId} AND status IN ('PENDING','RUNNING')`;
      if (pending[0].count >= 2n) throw new Error("A privacy request is already pending");
      await tx.$executeRaw`INSERT INTO privacy_jobs(id,user_id,kind,public_key) VALUES (${id}::uuid,${userId},${kind},${publicKey})`;
    });
    return { id, status: "PENDING" };
  }
  async status(userId: string, id: string) {
    const jobs = await this.db.$queryRaw<Job[]>`SELECT * FROM privacy_jobs WHERE id=${id}::uuid AND user_id=${userId}`;
    if (!jobs.length) return null;
    const job = jobs[0];
    return { id: job.id, kind: job.kind, status: job.status, expiresAt: job.expires_at,
      downloadUrl: job.kind === "EXPORT" && job.status === "DONE" && job.object_key && job.expires_at > new Date() ? await this.storage.link(job.object_key,job.expires_at) : undefined };
  }
  async runNext() {
    const jobs = await this.db.$queryRaw<Job[]>`WITH picked AS (
      SELECT id FROM privacy_jobs WHERE attempts < 5 AND expires_at > now()
      AND (status='PENDING' OR (status='RUNNING' AND updated_at < now()-interval '10 minutes'))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE privacy_jobs j SET status='RUNNING',attempts=attempts+1,updated_at=now(),
      object_key=CASE WHEN j.kind='EXPORT' THEN 'privacy/'||j.user_id||'/'||j.id::text||'.encrypted.json' ELSE j.object_key END
      FROM picked WHERE j.id=picked.id RETURNING j.*`;
    if (!jobs.length) return;
    const job = jobs[0];
    try {
      await this.db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${job.user_id},454))`;
        const erased = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM privacy_erased_accounts WHERE user_id=${job.user_id}`;
        if (erased[0].count) throw new Error("Account erased");
        if (job.kind === "EXPORT") {
          const manifest = await collectUserManifest(tx as never,job.user_id);
          const runtime = await runtimeUserRecords(tx,job.user_id,Object.keys(manifest.tables));
          for (const [table,records] of Object.entries(runtime)) manifest.tables[table]={ classification:"own runtime security records",records,sha256:"included in encrypted envelope" };
          manifest.tables["security_activity_memory"] = { classification: "current process security telemetry", records: securityAnomalyLog.query({ userId: job.user_id, limit: 1000 }), sha256: "included in encrypted envelope" };
          manifest.tables["active_sessions_memory"] = { classification: "current process session inventory", records: await sessionRegistryService.listUserSessions(job.user_id), sha256: "included in encrypted envelope" };
          const plain = Buffer.from(JSON.stringify(manifest));
          if(plain.length>50_000_000) { plain.fill(0); throw new Error("Export requires operator assistance"); }
          const encrypted = encryptExport(plain,job.public_key!);
          const key = job.object_key!;
          await this.storage.put(key,encrypted);
          await tx.$executeRaw`UPDATE privacy_jobs SET status='DONE',object_key=${key},updated_at=now() WHERE id=${job.id}::uuid`;
        } else {
          const exports = await tx.$queryRaw<Job[]>`SELECT * FROM privacy_jobs WHERE user_id=${job.user_id} AND object_key IS NOT NULL`;
          for (const item of exports) await this.storage.delete(item.object_key!);
          const account = await tx.user.findUniqueOrThrow({ where:{ id:job.user_id },select:{ email:true } });
          await loginSecurityService.forgetUser(job.user_id,account.email);
          await eraseUserData(tx as never,job.user_id);
          await eraseRuntimeSecurityRecords(tx,job.user_id);
          await tx.$executeRaw`INSERT INTO privacy_erased_accounts(user_id) VALUES (${job.user_id}) ON CONFLICT DO NOTHING`;
          await tx.$executeRaw`UPDATE privacy_jobs SET public_key=NULL,object_key=NULL,status='FAILED',error_code='ACCOUNT_ERASED',updated_at=now() WHERE user_id=${job.user_id} AND id<>${job.id}::uuid`;
          await tx.$executeRaw`UPDATE privacy_jobs SET status='DONE',updated_at=now() WHERE id=${job.id}::uuid`;
        }
      }, { isolationLevel: "Serializable", timeout: 120_000 });
      if (job.kind === "ERASE") {
        await sessionRegistryService.eraseUserSessions(job.user_id);
        securityAnomalyLog.eraseUser(job.user_id);
      }
    } catch {
      await this.db.$executeRaw`UPDATE privacy_jobs SET status=${job.attempts >= 5 ? "FAILED" : "PENDING"},error_code='PRIVACY_JOB_FAILED',updated_at=now() WHERE id=${job.id}::uuid`;
      throw new Error("Privacy job failed; no completion was recorded");
    }
  }
  async cleanup() {
    const jobs = await this.db.$queryRaw<Job[]>`SELECT * FROM privacy_jobs WHERE expires_at<=now() AND object_key IS NOT NULL LIMIT 100`;
    for (const job of jobs) {
      await this.storage.delete(job.object_key!);
      await this.db.$executeRaw`UPDATE privacy_jobs SET public_key=NULL,object_key=NULL,updated_at=now() WHERE id=${job.id}::uuid`;
    }
    await this.db.$executeRaw`UPDATE privacy_jobs SET public_key=NULL,status='FAILED',error_code='EXPIRED' WHERE expires_at<=now() AND status IN ('PENDING','RUNNING')`;
  }
}
export const privacyService = new PrivacyService();
