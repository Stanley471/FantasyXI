/**
 * Account signal recorder (issue #274).
 *
 * Persists the login signatures that link accounts in the Sybil graph: the
 * device ID of a fingerprinted browser and the client network (IPv4 /24,
 * IPv6 /64). One row per (type, value, account), refreshed with lastSeenAt on
 * every sign-in, so storage is bounded by the distinct signatures an account
 * really uses and each write is a single primary-key upsert.
 *
 * Recording is fire-and-forget, like securityAnomalyLog.record(): it never
 * throws and never adds latency to the sign-in that produced it.
 */

import net from "net";
import { prisma as defaultPrisma } from "../../config/db.js";
import { deriveDeviceId, FINGERPRINT_PATTERN } from "./loginSecurityService.js";

export interface SignInSignals {
  ip?: string | null;
  userAgent?: string | null;
  /** Browser entropy hash (frontend/src/lib/deviceFingerprint.ts) */
  deviceFingerprint?: string | null;
}

/** First four hextets of a valid IPv6 address, expanding "::" and an embedded IPv4 tail. */
function ipv6Prefix64(address: string): string {
  const [head, tail = ""] = address.split("%")[0].split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const width = (part: string[]) => part.reduce((n, group) => n + (group.includes(".") ? 2 : 1), 0);
  const headGroups = groups(head);
  const tailGroups = groups(tail);
  const gap = address.includes("::") ? 8 - width(headGroups) - width(tailGroups) : 0;
  const full = [...headGroups, ...Array<string>(gap).fill("0"), ...tailGroups];
  return `${full.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}

/** Client network in CIDR notation (IPv4 /24, IPv6 /64); null when the address is not an IP. */
export function toSubnet(ip: string): string | null {
  const address = ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split(".");
    return `${a}.${b}.${c}.0/24`;
  }
  return net.isIPv6(address) ? ipv6Prefix64(address) : null;
}

export class AccountSignalRecorder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = defaultPrisma) {}

  /** Records the signatures of a completed sign-in. Never throws. */
  public record(userId: string, signals: SignInSignals): void {
    const rows: Array<{ type: "DEVICE" | "IP_SUBNET"; value: string }> = [];
    // Without a fingerprint the device ID is a hash of the user agent alone,
    // which every user of the same browser build shares: not a linking signal
    if (signals.deviceFingerprint && FINGERPRINT_PATTERN.test(signals.deviceFingerprint)) {
      rows.push({ type: "DEVICE", value: deriveDeviceId(signals.deviceFingerprint, signals.userAgent) });
    }
    const subnet = signals.ip ? toSubnet(signals.ip) : null;
    if (subnet) rows.push({ type: "IP_SUBNET", value: subnet });

    const now = new Date();
    for (const row of rows) {
      try {
        this.db.accountSignal
          .upsert({
            where: { type_value_userId: { ...row, userId } },
            create: { ...row, userId, firstSeenAt: now, lastSeenAt: now },
            update: { lastSeenAt: now },
          })
          .catch((error: unknown) =>
            console.warn("[security] Failed to record account signal:", (error as Error).message)
          );
      } catch (error) {
        console.warn("[security] Failed to record account signal:", (error as Error).message);
      }
    }
  }
}

export const accountSignalRecorder = new AccountSignalRecorder();
