/**
 * k6 load test for end-of-gameweek leaderboard recalculation (issue #140).
 *
 * Exercises POST /api/v1/admin/leagues/recalculate-standings, which runs
 * LeagueService.recalculateClassicStandings — the bulk-aggregation path that
 * replaced the old per-league / per-member loop. The acceptance target is
 * "processing time for 1,000 leagues is under 10 seconds" against a database
 * seeded with 10,000+ users; see ../src/scripts/seedLoadTestData.ts.
 *
 * Setup:
 *   1. Seed the database:
 *        DATABASE_URL=... npx tsx backend/src/scripts/seedLoadTestData.ts
 *      (prints the seed gameweek id to pass in below)
 *   2. Start the API server against that same database.
 *   3. Get a JWT for a user with role ADMIN.
 *
 * Run:
 *   k6 run backend/loadtest/leaderboard-recalc.js \
 *     -e BASE_URL=http://localhost:5000 \
 *     -e ADMIN_TOKEN=<jwt> \
 *     -e GAMEWEEK_ID=<id printed by the seed script>
 */

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:5000";
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || "";
const GAMEWEEK_ID = __ENV.GAMEWEEK_ID || "1";

const recalcDuration = new Trend("recalc_duration_ms", true);

export const options = {
  scenarios: {
    end_of_gameweek_processing: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 5,
      maxDuration: "2m",
    },
  },
  thresholds: {
    // The acceptance criterion: a full platform recalculation must finish
    // in under 10 seconds even with 1,000+ leagues / 10,000+ members.
    recalc_duration_ms: ["p(95)<10000"],
    http_req_failed: ["rate==0"],
  },
};

export default function () {
  const res = http.post(
    `${BASE_URL}/api/v1/admin/leagues/recalculate-standings`,
    JSON.stringify({ gameweekId: Number(GAMEWEEK_ID) }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    }
  );

  recalcDuration.add(res.timings.duration);

  check(res, {
    "status is 200": (r) => r.status === 200,
    "recalculation succeeded": (r) => {
      try {
        return JSON.parse(r.body).success === true;
      } catch {
        return false;
      }
    },
  });
}
