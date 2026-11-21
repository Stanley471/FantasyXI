/**
 * Fire-and-forget health check ping on successful backup completion
 * (issue #504), e.g. a healthchecks.io or Better Uptime "success" URL.
 * A failed ping never fails the backup — the backup already succeeded.
 */
export async function pingBackupHealthcheck(
  url: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (!url) return;
  try {
    const response = await fetchImpl(url, { method: "GET" });
    if (!response.ok) {
      console.warn(`[backup] Health ping to ${url} returned HTTP ${response.status}`);
    }
  } catch (err) {
    console.warn(`[backup] Health ping to ${url} failed:`, (err as Error).message);
  }
}
