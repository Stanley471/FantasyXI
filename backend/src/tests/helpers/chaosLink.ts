/** Deterministic interception at service I/O boundaries, never installed in production. */
export type Fault = "pass" | "drop" | "disconnect" | "lose-response" | "latency";
export class ChaosLink {
  private step = 0;
  constructor(public faults: Fault[] = [], public latencyMs = 10) {}
  async call<T>(operation: () => Promise<T>): Promise<T> {
    const fault = this.faults[this.step++] ?? "pass";
    if (fault === "latency") await new Promise(resolve => setTimeout(resolve, this.latencyMs));
    if (fault === "drop") throw Object.assign(new Error("Injected RPC timeout (100% packet loss)"), { code: "ETIMEDOUT" });
    if (fault === "disconnect") throw Object.assign(new Error("Injected connection reset"), { code: "ECONNRESET" });
    const result = await operation();
    if (fault === "lose-response") throw new Error("Injected response loss after remote commit");
    return result;
  }
}
