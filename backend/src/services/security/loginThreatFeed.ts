import { isIP } from "node:net";

/** Operator-selected HTTPS JSON feed, never a URL supplied by a login request. */
export class LoginThreatFeed {
  private ips = new Set<string>();
  private refreshedAt = 0;
  private inFlight?: Promise<void>;
  constructor(private readonly url = () => process.env.LOGIN_THREAT_FEED_URL, private readonly http = fetch, private readonly now = Date.now) {}
  async contains(ip: string): Promise<boolean> {
    if (!this.url()) return false;
    if (!this.refreshedAt || this.now() - this.refreshedAt > 15 * 60_000) {
      try { await this.refresh(); }
      catch (error) { if (!this.refreshedAt || this.now() - this.refreshedAt > 60 * 60_000) throw error; }
    }
    return this.ips.has(ip.replace(/^::ffff:/, ""));
  }
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async load() {
    const configured = this.url();
    if (!configured) return;
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid threat-feed configuration");
    const response = await this.http(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok || !response.body) throw new Error("Threat feed unavailable");
    const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 2_000_000) throw new Error("Threat feed too large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(data) || data.length > 100_000 || data.some(ip => typeof ip !== "string" || !isIP(ip))) throw new Error("Invalid threat feed");
    this.ips = new Set(data); this.refreshedAt = this.now();
  }
}
export const loginThreatFeed = new LoginThreatFeed();
