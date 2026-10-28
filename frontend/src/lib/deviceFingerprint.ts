/**
 * Browser entropy fingerprint used to recognize a manager's devices at
 * sign-in (issue #331). The backend challenges a correct password from an
 * unrecognized device with an emailed code.
 *
 * Only signals that stay stable across sessions are used (no screen size or
 * zoom level, which change with external monitors), and only their SHA-256
 * digest leaves the browser.
 */

/** Renders fixed text and shapes; output differs subtly across GPUs, drivers and font stacks. */
function canvasSignature(): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 30;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.textBaseline = "top";
    ctx.font = "16px Arial";
    ctx.fillStyle = "#f60";
    ctx.fillRect(110, 1, 62, 20);
    ctx.fillStyle = "#069";
    ctx.fillText("FantasyXI ⚽ 1.0", 2, 8);
    return canvas.toDataURL();
  } catch {
    return "";
  }
}

/** Hex SHA-256 of the device's entropy, or null where Web Crypto is unavailable (insecure context). */
export async function computeDeviceFingerprint(): Promise<string | null> {
  if (typeof window === "undefined" || !window.crypto?.subtle) return null;

  const components = [
    navigator.userAgent,
    navigator.language,
    (navigator.languages ?? []).join(","),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    String(navigator.hardwareConcurrency ?? ""),
    String(navigator.maxTouchPoints ?? ""),
    String(window.screen?.colorDepth ?? ""),
    canvasSignature(),
  ];

  try {
    const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(components.join("|")));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}
