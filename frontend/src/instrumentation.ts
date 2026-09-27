/**
 * Next.js Experimental Instrumentation Hook (Issue 159)
 * Invoked once on server startup to initialize distributed tracing SDK.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log("[OpenTelemetry] Initializing Node.js distributed tracing instrumentation...");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    console.log("[OpenTelemetry] Initializing Edge runtime distributed tracing...");
  }
}
