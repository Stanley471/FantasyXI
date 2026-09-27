/**
 * Seeds a large synthetic dataset for the leaderboard-recalculation load test
 * (issue #140): 10,000 users, one squad each, and 1,000 classic leagues with
 * ~10 members apiece, plus a gameweek score per squad so standings actually
 * have something to rank.
 *
 * Everything is inserted with batched `createMany` calls (never one row at a
 * time) so seeding itself doesn't become the bottleneck.
 *
 * Run it against a disposable/staging database only — it's destructive-ish in
 * volume, not in intent, but you do not want 10k fake users in production:
 *   DATABASE_URL=postgres://... npx tsx src/scripts/seedLoadTestData.ts
 *
 * Env vars:
 *   LOAD_TEST_USERS   default 10000
 *   LOAD_TEST_LEAGUES default 1000
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const USER_COUNT = Number(process.env.LOAD_TEST_USERS) || 10_000;
const LEAGUE_COUNT = Number(process.env.LOAD_TEST_LEAGUES) || 1_000;
const MEMBERS_PER_LEAGUE = 10;
const BATCH_SIZE = 1_000;
const SEED_GAMEWEEK_FPL_ID = 900_001;

const prisma = new PrismaClient();

async function batchedCreateMany<T>(label: string, rows: T[], create: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await create(rows.slice(i, i + BATCH_SIZE));
    process.stdout.write(`\r${label}: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }
  process.stdout.write("\n");
}

async function main() {
  console.log(`Seeding ${USER_COUNT} users and ${LEAGUE_COUNT} leagues (${MEMBERS_PER_LEAGUE} members each)...`);

  const gameweek = await prisma.gameweek.upsert({
    where: { fplId: SEED_GAMEWEEK_FPL_ID },
    update: {},
    create: {
      fplId: SEED_GAMEWEEK_FPL_ID,
      name: "Load Test GW",
      deadline: new Date(),
      season: "load-test",
    },
  });

  const suffix = Date.now();
  const userRows = Array.from({ length: USER_COUNT }, (_, i) => ({
    email: `loadtest_${suffix}_${i}@fantasyxi.test`,
    username: `loadtest_${suffix}_${i}`,
    name: `Load Test User ${i}`,
  }));
  await batchedCreateMany("Users", userRows, (batch) => prisma.user.createMany({ data: batch }));

  const users = await prisma.user.findMany({
    where: { email: { startsWith: `loadtest_${suffix}_` } },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  const squadRows = users.map((u, i) => ({ userId: u.id, name: `Load Test Squad ${i}` }));
  await batchedCreateMany("Squads", squadRows, (batch) => prisma.squad.createMany({ data: batch }));

  const squads = await prisma.squad.findMany({
    where: { userId: { in: users.map((u) => u.id) } },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  const scoreRows = squads.map((s) => ({
    squadId: s.id,
    gameweekId: gameweek.id,
    points: Math.floor(Math.random() * 100),
  }));
  await batchedCreateMany("Gameweek scores", scoreRows, (batch) =>
    prisma.squadGameweekScore.createMany({ data: batch, skipDuplicates: true })
  );

  const leagueRows = Array.from({ length: LEAGUE_COUNT }, (_, i) => ({
    name: `Load Test League ${suffix}-${i}`,
    creatorId: users[i % users.length].id,
    inviteCode: `LT${suffix}${i}`,
    maxMembers: MEMBERS_PER_LEAGUE + 5,
    minMembers: 2,
    currentMembers: MEMBERS_PER_LEAGUE,
    status: "ACTIVE" as const,
    scoringType: "CLASSIC" as const,
    startGameweekId: gameweek.id,
    endGameweekId: gameweek.id,
  }));
  await batchedCreateMany("Leagues", leagueRows, (batch) => prisma.league.createMany({ data: batch }));

  const leagues = await prisma.league.findMany({
    where: { name: { startsWith: `Load Test League ${suffix}-` } },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  const memberRows: Array<{ leagueId: string; userId: string; squadId: string; status: "ACTIVE" }> = [];
  let cursor = 0;
  for (const league of leagues) {
    for (let m = 0; m < MEMBERS_PER_LEAGUE; m++) {
      const user = users[cursor % users.length];
      const squad = squads[cursor % squads.length];
      memberRows.push({ leagueId: league.id, userId: user.id, squadId: squad.id, status: "ACTIVE" });
      cursor++;
    }
  }
  await batchedCreateMany("League members", memberRows, (batch) =>
    prisma.leagueMember.createMany({ data: batch, skipDuplicates: true })
  );

  console.log(`\nDone. Seed gameweek id = ${gameweek.id} (pass this as gameweekId to the load test).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
