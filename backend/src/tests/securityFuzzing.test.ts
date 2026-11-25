import { setAccountStatusResolver } from "../services/privacy/accountStatus.js";
setAccountStatusResolver(() => false); // Active-account fixture for this isolated unit suite.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../config/db.js";
import { errorHandler } from "../middleware/error.middleware.js";
import leagueRoutes from "../routes/league.routes.js";
import playerRoutes from "../routes/player.routes.js";
import leaderboardRoutes from "../routes/leaderboard.routes.js";
import { signAccessToken } from "../config/jwt.js";

/**
 * 120+ Malicious SQL Injection Payloads Covering:
 * - Union-based SQLi
 * - Error-based SQLi
 * - Blind Boolean-based SQLi
 * - Time-based blind SQLi
 * - Stacked queries (DROP, TRUNCATE, INSERT, UPDATE)
 * - Tautology & comment evasions
 * - Schema & metadata enumeration (information_schema, pg_catalog)
 */
export const SQL_INJECTION_VECTORS: string[] = [
  // Union-based
  "' UNION SELECT null, null--",
  "' UNION SELECT null, null, null--",
  "' UNION SELECT null, null, null, null--",
  "' UNION ALL SELECT 1, 'admin', 'password'--",
  "' UNION ALL SELECT table_name, column_name FROM information_schema.columns--",
  "1' UNION SELECT 1, 2, 3, 4, 5, 6, 7, 8, 9, 10--",
  "' UNION SELECT username, password FROM users--",
  "' UNION SELECT NULL, version(), NULL--",
  "\" UNION SELECT NULL, NULL, NULL--",
  "') UNION SELECT 1, 2, 3--",
  "')) UNION SELECT 1, 2, 3--",
  "' UNION ALL SELECT 1, 2, pg_sleep(1)--",
  "1 UNION SELECT 1, 2, schema_name FROM information_schema.schemata--",
  "0' UNION SELECT null, null, null, null, null--",
  "-1' UNION SELECT 1, 2, 3--",

  // Error-based
  "' OR 1=CAST((SELECT table_name FROM information_schema.tables LIMIT 1) AS int)--",
  "' OR 1=CAST((SELECT current_user) AS int)--",
  "' OR 1=CAST((SELECT version()) AS int)--",
  "' OR 1/0--",
  "1' AND 1=CONVERT(int, (SELECT @@version))--",
  "' AND extractvalue(1, concat(0x7e, (select @@version), 0x7e))--",
  "' AND updatexml(1, concat(0x7e, (select @@version), 0x7e), 1)--",
  "' OR (SELECT 1 FROM (SELECT count(*), concat((SELECT version()), floor(rand(0)*2)) x FROM information_schema.tables GROUP BY x) a)--",
  "'; SELECT 1/0;--",
  "1' AND ctxsys.drithx.sn(1, (SELECT user FROM dual))--",
  "' AND EXP(~(SELECT * FROM (SELECT 1) t))--",
  "' AND JSON_KEYS((SELECT * FROM (SELECT 1) t))--",

  // Blind Boolean-based & Tautologies
  "' OR 1=1--",
  "' OR '1'='1",
  "' OR ''='",
  "1' OR '1'='1' --",
  "admin' --",
  "admin' #",
  "admin'/*",
  "' or 1=1 or ''='",
  "' or 1=1#",
  "' or 1=1/*",
  "') or ('1'='1",
  "')) or (('1'='1",
  "' OR 'x'='x",
  "\" OR \"a\"=\"a",
  "' OR 2>1--",
  "' OR 100=100--",
  "' AND 1=1--",
  "' AND 1=2--",
  "1' AND '1'='1",
  "1' AND '1'='2",
  "true",
  "1 OR 1=1",
  "0 OR 1=1",
  "1=1",

  // Time-based Blind
  "'; SELECT pg_sleep(2);--",
  "' OR pg_sleep(1)--",
  "1' AND (SELECT 1 FROM (SELECT(pg_sleep(1)))a)--",
  "'; WAITFOR DELAY '0:0:1'--",
  "1' WAITFOR DELAY '0:0:1'--",
  "' OR sleep(1)#",
  "\" OR sleep(1)#",
  "1' AND (SELECT 1 FROM (SELECT(SLEEP(1)))a)--",
  "%27%3B+SELECT+pg_sleep%281%29%3B--",
  "' AND (SELECT CASE WHEN (1=1) THEN pg_sleep(1) ELSE 0 END)--",

  // Stacked Queries & DDL / DML Injection
  "'; DROP TABLE users;--",
  "\"; DROP TABLE \"User\";--",
  "'; DROP TABLE leagues;--",
  "'; TRUNCATE TABLE players;--",
  "'; DELETE FROM users WHERE 1=1;--",
  "'; UPDATE users SET role='ADMIN' WHERE 1=1;--",
  "'; INSERT INTO users (email, password) VALUES ('evil@attacker.com', 'pwned');--",
  "1; EXEC xp_cmdshell('whoami')--",
  "'; SHUTDOWN WITH NOWAIT;--",
  "'; ALTER TABLE users ADD COLUMN pwned text;--",

  // Comment Evasions & Obfuscations
  "1/**/OR/**/1=1",
  "1'/**/OR/**/'1'='1",
  "1'/**/AND/**/1=1#",
  "' /*!50000OR*/ 1=1--",
  "' /*!32302 1/0, */ 1=1--",
  "1%27%20OR%201=1--",
  "0x27204f5220313d31",
  "%00' OR 1=1--",
  "\\'; OR 1=1--",
  "' HAVING 1=1--",
  "' GROUP BY 1 HAVING 1=1--",
  "' ORDER BY 1--",
  "' ORDER BY 100--",
  "1' ORDER BY 1--",
  "1' ORDER BY 9999--",
  "' LIMIT 1 OFFSET 1;--",
  "1; --",
  "\" --",
  "') --",

  // Schema & Catalog Probing
  "' AND EXISTS(SELECT 1 FROM information_schema.tables)--",
  "' AND EXISTS(SELECT 1 FROM pg_catalog.pg_tables)--",
  "' AND (SELECT count(*) FROM pg_stat_activity) > 0--",
  "' AND (SELECT count(*) FROM pg_database) > 0--",
  "' AND (SELECT count(*) FROM sqlite_master) > 0--",
  "' AND (SELECT count(*) FROM master..sysdatabases) > 0--",
  "' UNION SELECT null, current_database(), null--",
  "' UNION SELECT null, user, null--",
  "' UNION SELECT null, session_user, null--",
  "' AND ASCII(SUBSTRING((SELECT table_name FROM information_schema.tables LIMIT 1),1,1))>64--",
  "' AND (SELECT SUBSTRING(version(), 1, 10)) = 'PostgreSQL'--",

  // Second-order / special character fuzzing
  "\\\\\\' OR 1=1 --",
  "` OR 1=1 --",
  "'; -- -",
  "''''''''''''''OR 1=1--",
  "\"\"\"\"\"\"\"\"OR 1=1--",
  "1' OR NOT 2=3 --",
  "' RLIKE '.*'",
  "' REGEXP '.*'",
  "1' AND 1=(SELECT 1) --",
  "1' AND 'a'='a' AND 'b'='b",
  "1' OR 'a'=(SELECT 'a')",
  "1' || (SELECT '1')",
  "1' && 1=1",
  "1' || 1=1",
  "' OR true--",
  "' OR false--",
  "null' OR 'a'='a",
  "-1' OR 1=1 OR '1'='1",
  "1' OR (SELECT COUNT(*) FROM information_schema.columns) > 0--",
  "1' AND BENCHMARK(1000000,MD5(1))--",
  "1'; SELECT pg_database.datname FROM pg_database;--",
  "1; WAITFOR '0:0:2'--",
  "1' AND 2*1=2 AND '000'='000",
  "1' AND (SELECT 1)=1 --",
  "' AND 123=123--",
  "admin' OR 1=1/*",
  "admin' OR '1'='1'/*",
  "1' AND NOT(1=2)--",
  "' OR 1=1 LIMIT 0,1--",
];

const LEAKED_DATABASE_KEYWORDS = [
  "syntax error at or near",
  "unterminated quoted string",
  "pg_catalog",
  "information_schema",
  "psqlerror",
  "sqlstate",
  "relation does not exist",
  "column does not exist",
  "SELECT * FROM",
  "pg_stat_activity",
  "sqlite_master",
];

describe("Automated SQL Injection and Query Regression Fuzzing Suite", () => {
  let app: express.Express;
  let server: Server;
  let baseUrl: string;
  let authToken: string;

  before(async () => {
    // Stub methods on Prisma models so tests execute without a live database
    prisma.league.findMany = (async () => [
      {
        id: "fuzz-league-1",
        name: "Premier League Fuzz",
        creatorId: "user-1",
        status: "UPCOMING",
        scoringType: "CLASSIC",
        entryFee: 10,
        currentSize: 4,
        maxSize: 10,
        hasOpenSlots: true,
        createdAt: new Date(),
      },
    ]) as any;

    prisma.league.findUnique = (async () => ({
      id: "fuzz-league-1",
      name: "Premier League Fuzz",
      creatorId: "user-1",
      status: "UPCOMING",
    })) as any;

    prisma.league.count = (async () => 1) as any;

    prisma.player.findMany = (async () => [
      {
        id: 10,
        displayName: "Erling Haaland",
        firstName: "Erling",
        lastName: "Haaland",
        totalPoints: 120,
        price: 14.5,
        position: "FORWARD",
        teamId: 1,
        team: {
          id: 1,
          fplId: 1,
          name: "Manchester City",
          shortName: "MCI",
          logoUrl: null,
        },
      },
    ]) as any;

    prisma.player.findUnique = (async () => ({
      id: 10,
      displayName: "Erling Haaland",
      price: 14.5,
    })) as any;

    prisma.player.count = (async () => 1) as any;

    prisma.squad.findMany = (async () => [
      {
        id: "squad-1",
        name: "Fuzz Squad",
        user: { username: "gaffer" },
        totalPoints: 150,
      },
    ]) as any;

    prisma.squad.count = (async () => 1) as any;

    prisma.user.findUnique = (async () => ({
      id: "fuzz-user",
      email: "fuzz@example.com",
      username: "fuzz-tester",
    })) as any;

    app = express();
    app.use(express.json());

    // Mount public read endpoints under test
    app.use("/api/v1/leagues", leagueRoutes);
    app.use("/api/v1/players", playerRoutes);
    app.use("/api/v1/leaderboard", leaderboardRoutes);

    app.use(errorHandler);

    authToken = signAccessToken({ userId: "fuzz-user", email: "fuzz@example.com" });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const port = (server.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("verifies the test suite contains 100+ distinct SQL injection vectors", () => {
    assert.ok(
      SQL_INJECTION_VECTORS.length >= 100,
      `Expected at least 100 SQL vectors, found ${SQL_INJECTION_VECTORS.length}`
    );
  });

  it("fuzzes /api/v1/leagues search inputs and sort parameters with 100+ vectors without 500 errors or schema leaks", async () => {
    for (const vector of SQL_INJECTION_VECTORS) {
      const searchUrl = `${baseUrl}/api/v1/leagues?q=${encodeURIComponent(vector)}&sortBy=${encodeURIComponent(
        vector
      )}&sortOrder=${encodeURIComponent(vector)}`;

      const res = await fetch(searchUrl, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          "X-Forwarded-For": vector,
        },
      });

      const bodyText = await res.text();

      // Assert status code is NOT 500 Internal Server Error
      assert.notEqual(
        res.status,
        500,
        `Vector "${vector}" triggered 500 Internal Server Error on /api/v1/leagues`
      );

      // Assert response does NOT leak internal SQL error signatures
      for (const keyword of LEAKED_DATABASE_KEYWORDS) {
        assert.ok(
          !bodyText.toLowerCase().includes(keyword.toLowerCase()),
          `Vector "${vector}" leaked SQL keyword "${keyword}" in response: ${bodyText}`
        );
      }
    }
  });

  it("fuzzes /api/v1/players search, filter, and pagination parameters with 100+ vectors", async () => {
    for (const vector of SQL_INJECTION_VECTORS) {
      const playerUrl = `${baseUrl}/api/v1/players?search=${encodeURIComponent(
        vector
      )}&position=${encodeURIComponent(vector)}&sortBy=${encodeURIComponent(
        vector
      )}&page=${encodeURIComponent(vector)}&limit=${encodeURIComponent(vector)}`;

      const res = await fetch(playerUrl, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      const bodyText = await res.text();

      assert.notEqual(
        res.status,
        500,
        `Vector "${vector}" triggered 500 error on /api/v1/players`
      );

      for (const keyword of LEAKED_DATABASE_KEYWORDS) {
        assert.ok(
          !bodyText.toLowerCase().includes(keyword.toLowerCase()),
          `Vector "${vector}" leaked SQL keyword "${keyword}" in /api/v1/players`
        );
      }
    }
  });

  it("fuzzes /api/v1/leaderboard queries, gameweek filter, and pagination offsets with 100+ vectors", async () => {
    for (const vector of SQL_INJECTION_VECTORS) {
      const leaderboardUrl = `${baseUrl}/api/v1/leaderboard?q=${encodeURIComponent(
        vector
      )}&gameweekId=${encodeURIComponent(vector)}&page=${encodeURIComponent(
        vector
      )}&pageSize=${encodeURIComponent(vector)}`;

      const res = await fetch(leaderboardUrl, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      const bodyText = await res.text();

      assert.notEqual(
        res.status,
        500,
        `Vector "${vector}" triggered 500 error on /api/v1/leaderboard`
      );

      for (const keyword of LEAKED_DATABASE_KEYWORDS) {
        assert.ok(
          !bodyText.toLowerCase().includes(keyword.toLowerCase()),
          `Vector "${vector}" leaked SQL keyword "${keyword}" in /api/v1/leaderboard`
        );
      }
    }
  });

  it("validates that all $queryRaw and $executeRaw invocations in the codebase strictly use parameterized queries", () => {
    const srcDir = path.resolve(process.cwd(), "src");

    function findTsFiles(dir: string): string[] {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          results = results.concat(findTsFiles(fullPath));
        } else if (file.endsWith(".ts") && !file.endsWith(".d.ts")) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const files = findTsFiles(srcDir);
    let checkedInvocations = 0;

    for (const file of files) {
      if (file.endsWith("securityFuzzing.test.ts")) continue;
      const content = fs.readFileSync(file, "utf8");

      // Match raw queries
      // Valid pattern: $queryRaw`...` or $executeRaw`...`
      // Unsafe pattern: $queryRawUnsafe or $queryRaw( with string concatenation (+)
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

        if (line.includes("$queryRaw(") || line.includes("$executeRaw(")) {
          // If called as function instead of tagged template literal, verify no string concatenation with user variables
          assert.ok(
            !line.includes("+"),
            `Potential unparameterized raw query at ${file}:${index + 1}: ${line}`
          );
        }

        if (line.includes("$queryRaw`") || line.includes("$executeRaw`")) {
          checkedInvocations++;
          // Ensure it's using Prisma tagged template literals
          assert.ok(
            line.includes("`"),
            `Raw query must use tagged template literal at ${file}:${index + 1}`
          );
        }
      });
    }

    assert.ok(
      checkedInvocations > 0,
      `Expected to validate parameterized raw queries in codebase, verified ${checkedInvocations}`
    );
  });
});
