import type { IncomingHttpHeaders } from "http";

/**
 * Geographic login-velocity primitives (issue #331): great-circle distance
 * between successive logins and the "impossible travel" decision. Pure
 * functions, O(1) time and space.
 */

/** IUGG mean Earth radius (R1), in kilometres. */
export const EARTH_MEAN_RADIUS_KM = 6371.0088;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface TravelPolicy {
  /** Fastest plausible travel; commercial jets cruise at roughly 900 km/h. */
  maxSpeedKmh: number;
  /**
   * Distance discounted from every comparison to absorb IP-geolocation error
   * (city-level estimates are often tens to hundreds of km off).
   */
  toleranceKm: number;
}

export const DEFAULT_TRAVEL_POLICY: TravelPolicy = { maxSpeedKmh: 1000, toleranceKm: 200 };

export interface TravelAssessment {
  distanceKm: number;
  elapsedHours: number;
  /** Speed needed to cover the distance beyond the tolerance; Infinity for zero elapsed time. */
  requiredSpeedKmh: number;
  impossible: boolean;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance by the haversine formula:
 *   a = sin²(Δφ/2) + cos φ1 · cos φ2 · sin²(Δλ/2),  d = 2R · atan2(√a, √(1−a))
 * Accurate to about 0.5% on the real (ellipsoidal) Earth, far finer than IP
 * geolocation itself.
 */
export function haversineDistanceKm(from: GeoPoint, to: GeoPoint): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(dLon / 2) ** 2;
  // Clamp: rounding can push `a` a hair outside [0, 1] for antipodal points
  const clamped = Math.min(1, Math.max(0, a));
  return 2 * EARTH_MEAN_RADIUS_KM * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

/** Whether travelling between two timed locations would require an implausible speed. */
export function assessTravel(
  previous: { point: GeoPoint; at: number },
  current: { point: GeoPoint; at: number },
  policy: TravelPolicy = DEFAULT_TRAVEL_POLICY
): TravelAssessment {
  const distanceKm = haversineDistanceKm(previous.point, current.point);
  const elapsedHours = Math.max(0, current.at - previous.at) / 3_600_000;
  const effectiveKm = Math.max(0, distanceKm - policy.toleranceKm);

  let requiredSpeedKmh = 0;
  if (effectiveKm > 0) {
    requiredSpeedKmh = elapsedHours > 0 ? effectiveKm / elapsedHours : Infinity;
  }
  return { distanceKm, elapsedHours, requiredSpeedKmh, impossible: requiredSpeedKmh > policy.maxSpeedKmh };
}

/**
 * Edge-network headers carrying the client's IP-derived coordinates:
 * - Cloudflare "Add visitor location headers" managed transform
 * - Amazon CloudFront viewer location headers (origin request policy)
 * Node lower-cases incoming header names.
 */
const GEO_HEADERS = {
  cloudflare: { latitude: "cf-iplatitude", longitude: "cf-iplongitude" },
  cloudfront: { latitude: "cloudfront-viewer-latitude", longitude: "cloudfront-viewer-longitude" },
} as const;

export type GeoHeaderSource = keyof typeof GEO_HEADERS;

function readCoordinate(value: string | string[] | undefined, limit: number): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.trim()) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
}

/**
 * Reads the client's location from the configured edge network's headers.
 * Headers are only trusted when GEOIP_HEADER_SOURCE names the proxy that sits
 * in front of the API (otherwise any client could forge them), so this
 * returns null when unconfigured or when the headers are absent or invalid.
 */
export function locateFromHeaders(
  headers: IncomingHttpHeaders,
  source: string | undefined = process.env.GEOIP_HEADER_SOURCE
): GeoPoint | null {
  if (source !== "cloudflare" && source !== "cloudfront") return null;
  const names = GEO_HEADERS[source];
  const latitude = readCoordinate(headers[names.latitude], 90);
  const longitude = readCoordinate(headers[names.longitude], 180);
  return latitude === null || longitude === null ? null : { latitude, longitude };
}
