import { prisma } from "../../config/db.js";
import type { LoginAttempt } from "./loginSecurityService.js";
import type { GeoPoint } from "./geoVelocity.js";

export interface LoginActivityStore {
  record(attempt: LoginAttempt, outcome: string, at: number): Promise<void>;
  trustLocation(userId: string, location: GeoPoint, at: number): Promise<void>;
}

export const loginActivityStore: LoginActivityStore = {
  async record(attempt, outcome, at) {
    const ua = attempt.userAgent ?? "";
    const browser = /Firefox/i.test(ua) ? "Firefox" : /Edg/i.test(ua) ? "Edge" : /Chrome/i.test(ua) ? "Chrome" : /Safari/i.test(ua) ? "Safari" : "Other";
    const device = /Mobile|Android|iPhone/i.test(ua) ? "mobile" : /iPad|Tablet/i.test(ua) ? "tablet" : "desktop";
    const latitude = attempt.location ? Math.round(attempt.location.latitude * 100) / 100 : null;
    const longitude = attempt.location ? Math.round(attempt.location.longitude * 100) / 100 : null;
    await prisma.$executeRaw`INSERT INTO login_security_activity (id,user_id,ip,browser,device,latitude,longitude,asn,outcome,created_at)
      VALUES (gen_random_uuid(),${attempt.userId},${attempt.ip},${browser},${device},${latitude},${longitude},${attempt.asn ?? null},${outcome},${new Date(at)})`;
  },
  async trustLocation(userId, location, at) {
    const latitude = Math.round(location.latitude * 100) / 100;
    const longitude = Math.round(location.longitude * 100) / 100;
    await prisma.$executeRaw`INSERT INTO login_trusted_locations (user_id,latitude,longitude,verified_at)
      VALUES (${userId},${latitude},${longitude},${new Date(at)})
      ON CONFLICT (user_id,latitude,longitude) DO UPDATE SET verified_at=EXCLUDED.verified_at`;
  },
};

export async function readOwnSecurityActivity(userId: string) {
  return prisma.$queryRaw`SELECT id,ip,browser,device,latitude,longitude,asn,outcome,created_at
    FROM login_security_activity WHERE user_id=${userId} ORDER BY created_at DESC,id DESC LIMIT 100`;
}
