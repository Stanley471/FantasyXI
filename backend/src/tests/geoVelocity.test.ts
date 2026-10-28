import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EARTH_MEAN_RADIUS_KM,
  assessTravel,
  haversineDistanceKm,
  locateFromHeaders,
} from "../services/security/geoVelocity.js";

/**
 * Issue #331: great-circle (haversine) distance and impossible-travel speed
 * checks between successive logins.
 */

const HOUR = 3_600_000;
const LONDON = { latitude: 51.5074, longitude: -0.1278 };
const PARIS = { latitude: 48.8566, longitude: 2.3522 };
const SYDNEY = { latitude: -33.8688, longitude: 151.2093 };
const NEW_YORK = { latitude: 40.7128, longitude: -74.006 };

describe("haversineDistanceKm (#331)", () => {
  it("matches the Rosetta Code reference value for Nashville (BNA) to Los Angeles (LAX)", () => {
    // Reference: 2887.2599506071106 km with R = 6372.8 km; distance scales linearly with R
    const km = haversineDistanceKm({ latitude: 36.12, longitude: -86.67 }, { latitude: 33.94, longitude: -118.4 });
    assert.ok(Math.abs(km * (6372.8 / EARTH_MEAN_RADIUS_KM) - 2887.2599506071106) < 1e-6);
  });

  it("follows the sphere's geometry: zero, one degree of equator, quarter meridian, antipodes", () => {
    assert.equal(haversineDistanceKm(LONDON, LONDON), 0);
    const oneDegree = (2 * Math.PI * EARTH_MEAN_RADIUS_KM) / 360;
    assert.ok(Math.abs(haversineDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) - oneDegree) < 1e-9);
    assert.ok(
      Math.abs(haversineDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 90, longitude: 0 }) - (Math.PI * EARTH_MEAN_RADIUS_KM) / 2) < 1e-9
    );
    assert.ok(
      Math.abs(haversineDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 }) - Math.PI * EARTH_MEAN_RADIUS_KM) < 1e-9
    );
  });

  it("is symmetric and handles the antimeridian and southern hemisphere", () => {
    assert.equal(haversineDistanceKm(LONDON, SYDNEY), haversineDistanceKm(SYDNEY, LONDON));
    // Across the date line: 179.5E to 179.5W is one degree of longitude on the equator
    const acrossDateLine = haversineDistanceKm({ latitude: 0, longitude: 179.5 }, { latitude: 0, longitude: -179.5 });
    assert.ok(Math.abs(acrossDateLine - (2 * Math.PI * EARTH_MEAN_RADIUS_KM) / 360) < 1e-6);
    const londonParis = haversineDistanceKm(LONDON, PARIS);
    assert.ok(londonParis > 340 && londonParis < 346, `London-Paris was ${londonParis}`);
  });
});

describe("assessTravel (#331)", () => {
  it("flags London to Sydney within an hour as impossible", () => {
    const result = assessTravel({ point: LONDON, at: 0 }, { point: SYDNEY, at: HOUR });
    assert.equal(result.impossible, true);
    assert.ok(result.distanceKm > 16_900 && result.distanceKm < 17_100);
    assert.ok(result.requiredSpeedKmh > 16_000);
  });

  it("allows the same trip after a realistic flight time", () => {
    const result = assessTravel({ point: LONDON, at: 0 }, { point: SYDNEY, at: 22 * HOUR });
    assert.equal(result.impossible, false);
  });

  it("allows London to Paris after a 40-minute gap but not after 5 minutes", () => {
    assert.equal(assessTravel({ point: LONDON, at: 0 }, { point: PARIS, at: 40 * 60_000 }).impossible, false);
    assert.equal(assessTravel({ point: LONDON, at: 0 }, { point: PARIS, at: 5 * 60_000 }).impossible, true);
  });

  it("absorbs geolocation error: nearby positions are never impossible, even simultaneously", () => {
    const nearby = { latitude: 51.6, longitude: 0.5 }; // ~45 km from central London
    const result = assessTravel({ point: LONDON, at: 0 }, { point: nearby, at: 0 });
    assert.equal(result.requiredSpeedKmh, 0);
    assert.equal(result.impossible, false);
  });

  it("treats a far login at the same instant (or a clock going backwards) as impossible", () => {
    assert.equal(assessTravel({ point: NEW_YORK, at: HOUR }, { point: LONDON, at: HOUR }).requiredSpeedKmh, Infinity);
    assert.equal(assessTravel({ point: NEW_YORK, at: 2 * HOUR }, { point: LONDON, at: HOUR }).impossible, true);
  });

  it("honours a custom policy", () => {
    const policy = { maxSpeedKmh: 100, toleranceKm: 0 };
    assert.equal(assessTravel({ point: LONDON, at: 0 }, { point: PARIS, at: 2 * HOUR }, policy).impossible, true);
  });
});

describe("locateFromHeaders (#331)", () => {
  it("reads Cloudflare and CloudFront coordinates only from the configured source", () => {
    const headers = {
      "cf-iplatitude": "51.5074",
      "cf-iplongitude": "-0.1278",
      "cloudfront-viewer-latitude": "40.7128",
      "cloudfront-viewer-longitude": "-74.0060",
    };
    assert.deepEqual(locateFromHeaders(headers, "cloudflare"), { latitude: 51.5074, longitude: -0.1278 });
    assert.deepEqual(locateFromHeaders(headers, "cloudfront"), { latitude: 40.7128, longitude: -74.006 });
    assert.equal(locateFromHeaders(headers, undefined), null, "untrusted when no edge proxy is configured");
  });

  it("rejects missing, malformed and out-of-range coordinates", () => {
    assert.equal(locateFromHeaders({}, "cloudflare"), null);
    assert.equal(locateFromHeaders({ "cf-iplatitude": "abc", "cf-iplongitude": "1" }, "cloudflare"), null);
    assert.equal(locateFromHeaders({ "cf-iplatitude": "91", "cf-iplongitude": "1" }, "cloudflare"), null);
    assert.equal(locateFromHeaders({ "cf-iplatitude": "10", "cf-iplongitude": "-181" }, "cloudflare"), null);
    assert.equal(locateFromHeaders({ "cf-iplatitude": "", "cf-iplongitude": "" }, "cloudflare"), null);
  });
});
