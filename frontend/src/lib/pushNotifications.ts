/**
 * pushNotifications.ts — FantasyXI Issue #151
 *
 * Utilities for registering the service worker, requesting push notification
 * permission, subscribing via the PushManager API (VAPID), and syncing the
 * resulting PushSubscription with the backend.
 */

/** VAPID public key injected by Next.js at build time. */
export const VAPID_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a URL-safe Base64 VAPID public key to the Uint8Array expected by
 * the PushManager.subscribe() applicationServerKey option.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  // Pad the string to a multiple of 4 characters
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

// ---------------------------------------------------------------------------
// Service Worker
// ---------------------------------------------------------------------------

/**
 * Registers (or retrieves) the FantasyXI service worker.
 * Returns null if the browser does not support service workers.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) {
    console.warn("[Push] Service Workers are not supported by this browser.");
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    // Trigger an update check so we always run the latest SW version
    await registration.update();
    return registration;
  } catch (err) {
    console.error("[Push] Service Worker registration failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

/**
 * Requests the browser notification permission.
 * Returns the resulting NotificationPermission ('granted' | 'denied' | 'default').
 * Returns 'denied' if the Notification API is unavailable.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) {
    console.warn("[Push] Notifications are not supported by this browser.");
    return "denied";
  }

  const permission = await Notification.requestPermission();
  return permission;
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/**
 * Creates a new push subscription for the given ServiceWorkerRegistration
 * using the application's VAPID public key.
 * Returns null if subscription fails.
 */
export async function subscribeToPush(
  registration: ServiceWorkerRegistration
): Promise<PushSubscription | null> {
  if (!VAPID_PUBLIC_KEY) {
    console.error(
      "[Push] NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set. Cannot subscribe to push notifications."
    );
    return null;
  }

  try {
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    return subscription;
  } catch (err) {
    console.error("[Push] Failed to subscribe to push notifications:", err);
    return null;
  }
}

/**
 * Sends a PushSubscription to the backend so the server can later send
 * push messages to this specific browser instance.
 */
export async function sendSubscriptionToServer(
  subscription: PushSubscription
): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(subscription),
  });

  if (!response.ok) {
    throw new Error(
      `[Push] Failed to send subscription to server: ${response.status} ${response.statusText}`
    );
  }
}

// ---------------------------------------------------------------------------
// Unsubscription
// ---------------------------------------------------------------------------

/**
 * Cancels the active push subscription for the given ServiceWorkerRegistration
 * and notifies the backend so it can remove the stored endpoint.
 */
export async function unsubscribeFromPush(
  registration: ServiceWorkerRegistration
): Promise<void> {
  const subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    return; // Nothing to unsubscribe from
  }

  // Notify the backend before unsubscribing so the endpoint is still valid
  try {
    await fetch(`${API_BASE}/api/v1/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(subscription),
    });
  } catch (err) {
    console.warn("[Push] Could not notify server of unsubscription:", err);
  }

  await subscription.unsubscribe();
}
