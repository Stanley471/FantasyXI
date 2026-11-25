import test from "node:test";
import assert from "node:assert/strict";
import { LoginSecurityService, type LoginAttempt } from "../services/security/loginSecurityService.js";
import { assessTravel, haversineDistanceKm } from "../services/security/geoVelocity.js";
import { LoginThreatFeed } from "../services/security/loginThreatFeed.js";
import { trustedLoginSignals } from "../services/security/trustedLoginSignals.js";

test("untrusted peers cannot forge location, ASN or forwarded client IP", () => {
  const keys=["LOGIN_TRUSTED_PROXY_CIDRS","GEOIP_HEADER_SOURCE","LOGIN_ASN_HEADER"];
  const previous=keys.map(key=>process.env[key]);
  const request={ip:"203.0.113.20",socket:{remoteAddress:"198.51.100.7"},headers:{"cf-iplatitude":"51.5","cf-iplongitude":"0","x-asn":"AS123"}};
  try {
    process.env.LOGIN_TRUSTED_PROXY_CIDRS="192.0.2.0/24"; process.env.LOGIN_ASN_HEADER="x-asn";
    delete process.env.GEOIP_HEADER_SOURCE;
    assert.deepEqual(trustedLoginSignals(request as never),{ip:"198.51.100.7",location:null,asn:null});
    process.env.GEOIP_HEADER_SOURCE="cloudflare";
    assert.throws(()=>trustedLoginSignals(request as never),/trusted proxy/);
    request.socket.remoteAddress="::ffff:192.0.2.5";
    assert.deepEqual(trustedLoginSignals(request as never),{ip:"203.0.113.20",location:{latitude:51.5,longitude:0},asn:"123"});
    request.headers["cf-iplatitude"]="NaN";
    assert.throws(()=>trustedLoginSignals(request as never),/unavailable/);
  } finally { keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];}); }
});

test("800 km/h boundary, invalid coordinates, antipodes and zero/backward time", () => {
  const london = { latitude: 51.5, longitude: -0.12 }, tokyo = { latitude: 35.68, longitude: 139.69 };
  const distance = haversineDistanceKm(london, tokyo);
  assert.ok(distance > 9500 && distance < 9700);
  const at = distance / 800 * 3_600_000;
  assert.equal(assessTravel({ point: london, at: 0 }, { point: tokyo, at: at + 1 }, { maxSpeedKmh: 800, toleranceKm: 0 }).impossible, false);
  assert.equal(assessTravel({ point: london, at: 0 }, { point: tokyo, at: at - 1 }, { maxSpeedKmh: 800, toleranceKm: 0 }).impossible, true);
  for (const end of [0, -1]) assert.equal(assessTravel({ point: london, at: 0 }, { point: tokyo, at: end }).impossible, true);
  assert.equal(assessTravel({ point: london, at: 0 }, { point: london, at: 0 }).impossible, false);
  assert.ok(Number.isFinite(haversineDistanceKm({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 180 })));
  assert.throws(() => haversineDistanceKm(london, { latitude: NaN, longitude: 0 }));
});

test("impossible travel yields a single-use challenge; only verification trusts location", async () => {
  let now = 1_000_000; const mail: string[] = []; const trusted: unknown[] = []; const activity: string[] = [];
  const service = new LoginSecurityService({ redis: null, anomalyChallenges: true, now: () => now, travelPolicy: { maxSpeedKmh: 800, toleranceKm: 0 },
    mailer: { send: async message => { mail.push(message.text); } },
    activity: { record: async (_attempt, outcome) => { activity.push(outcome); }, trustLocation: async (...args) => { trusted.push(args); } },
  });
  const attempt: LoginAttempt = { userId: "synthetic-user", email: "user@example.test", username: "synthetic", ip: "198.51.100.2", deviceFingerprint: "synthetic-device-hash", location: { latitude: 51.5, longitude: 0 } };
  assert.equal((await service.assessLogin(attempt)).decision, "ALLOW");
  now += 15 * 60_000;
  const held = await service.assessLogin({ ...attempt, location: { latitude: 35.68, longitude: 139.69 } });
  assert.equal(held.decision, "CHALLENGE"); assert.equal(trusted.length, 0);
  if (held.decision !== "CHALLENGE") throw new Error("expected challenge");
  const code = mail[0].match(/code is: (\d{6})/)![1];
  const results = await Promise.all([service.verifyChallenge(held.challengeId, code), service.verifyChallenge(held.challengeId, code)]);
  assert.equal(results.filter(x => x.verified).length, 1); assert.equal(trusted.length, 1);
  assert.deepEqual(activity, ["ALLOWED", "IMPOSSIBLE_TRAVEL", "VERIFIED"]);
});

test("ASN change and known proxy risk require verification even for a remembered device", async () => {
  const service = new LoginSecurityService({ redis: null, anomalyChallenges: true, mailer: { send: async () => {} }, isThreatIp: async ip => ip === "198.51.100.3" });
  const attempt: LoginAttempt = { userId: "u", email: "u@example.test", username: "u", ip: "198.51.100.2", asn: "100" };
  assert.equal((await service.assessLogin(attempt)).decision, "ALLOW");
  assert.equal((await service.assessLogin({ ...attempt, asn: "200" })).decision, "CHALLENGE");
  assert.equal((await service.assessLogin({ ...attempt, ip: "198.51.100.3" })).decision, "CHALLENGE");
});

test("threat feed validates data, uses bounded last-known data and refuses expired evidence", async () => {
  let now = 1; let fail = false;
  const feed = new LoginThreatFeed(() => "https://feed.example.test/proxies.json", async () => {
    if (fail) throw new Error("unavailable");
    return new Response(JSON.stringify(["198.51.100.7"]));
  }, () => now);
  assert.equal(await feed.contains("198.51.100.7"), true);
  fail = true; now += 16 * 60_000;
  assert.equal(await feed.contains("198.51.100.7"), true);
  now += 60 * 60_000;
  await assert.rejects(() => feed.contains("198.51.100.7"));
});
