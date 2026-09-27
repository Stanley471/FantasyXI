import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Request, Response, NextFunction } from "express";
import {
    getGameweeks,
    getCurrentGameweek,
    getGameweekById,
    getMyGameweekHistory,
} from "../controllers/gameweek.controller.js";
import { prisma } from "../config/db.js";

function createMockReqRes(options: {
    user?: { id: string };
    params?: Record<string, string>;
    body?: Record<string, unknown>;
}) {
    let statusCode = 200;
    let jsonResponse: any = null;
    let nextError: any = null;

    const req = {
        user: options.user,
        params: options.params || {},
        body: options.body || {},
    } as unknown as Request;

    const res = {
        status: (code: number) => {
            statusCode = code;
            return res;
        },
        json: (payload: any) => {
            jsonResponse = payload;
            return res;
        },
    } as unknown as Response;

    const next: NextFunction = (err?: any) => {
        nextError = err;
    };

    return {
        req,
        res,
        next,
        getStatusCode: () => statusCode,
        getJsonResponse: () => jsonResponse,
        getNextError: () => nextError,
    };
}

describe("Gameweek Controller", () => {
    const originalGameweekFindMany = prisma.gameweek.findMany;
    const originalGameweekFindFirst = prisma.gameweek.findFirst;
    const originalGameweekFindUnique = prisma.gameweek.findUnique;
    const originalSquadGameweekScoreFindMany = prisma.squadGameweekScore.findMany;

    afterEach(() => {
        (prisma.gameweek as any).findMany = originalGameweekFindMany;
        (prisma.gameweek as any).findFirst = originalGameweekFindFirst;
        (prisma.gameweek as any).findUnique = originalGameweekFindUnique;
        (prisma.squadGameweekScore as any).findMany = originalSquadGameweekScoreFindMany;
    });

    it("should return all gameweeks in ascending fpl order", async () => {
        const gameweeks = [
            { id: 1, fplId: 1, isCurrent: false, isFinished: false },
            { id: 2, fplId: 2, isCurrent: true, isFinished: false },
        ];

        (prisma.gameweek as any).findMany = async (args: any) => {
            assert.deepEqual(args.orderBy, { fplId: "asc" });
            return gameweeks;
        };

        const { req, res, next, getJsonResponse } = createMockReqRes({});

        await getGameweeks(req, res, next);

        assert.equal(getJsonResponse().success, true);
        assert.deepEqual(getJsonResponse().data, gameweeks);
    });

    it("should return the current gameweek when available", async () => {
        const currentGameweek = {
            id: 2,
            fplId: 2,
            isCurrent: true,
            fixtures: [{ id: 21, kickoffTime: "2026-09-30T18:00:00.000Z" }],
        };

        (prisma.gameweek as any).findFirst = async (args: any) => {
            assert.deepEqual(args.where, { isCurrent: true });
            assert.equal(args.include.fixtures.include.homeTeam, true);
            assert.equal(args.include.fixtures.include.awayTeam, true);
            return currentGameweek;
        };

        const { req, res, next, getJsonResponse } = createMockReqRes({});

        await getCurrentGameweek(req, res, next);

        assert.equal(getJsonResponse().success, true);
        assert.deepEqual(getJsonResponse().data, currentGameweek);
    });

    it("should fall back to the next unfinished gameweek when no current week is set", async () => {
        const nextUpcoming = {
            id: 3,
            fplId: 3,
            isCurrent: false,
            isFinished: false,
            fixtures: [{ id: 31, kickoffTime: "2026-10-02T18:00:00.000Z" }],
        };

        (prisma.gameweek as any).findFirst = async (args: any) => {
            if (args.where && args.where.isCurrent === true) {
                return null;
            }

            assert.deepEqual(args.where, { isFinished: false });
            assert.deepEqual(args.orderBy, { deadline: "asc" });
            return nextUpcoming;
        };

        const { req, res, next, getJsonResponse } = createMockReqRes({});

        await getCurrentGameweek(req, res, next);

        assert.equal(getJsonResponse().success, true);
        assert.deepEqual(getJsonResponse().data, nextUpcoming);
    });

    it("should return 400 for invalid gameweek id values", async () => {
        const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes({
            params: { id: "abc" },
        });

        await getGameweekById(req, res, next);

        assert.equal(getStatusCode(), 400);
        assert.equal(getJsonResponse().success, false);
        assert.match(getJsonResponse().message, /Invalid gameweek ID/);
    });

    it("should return 404 when the requested gameweek does not exist", async () => {
        (prisma.gameweek as any).findUnique = async () => null;

        const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes({
            params: { id: "42" },
        });

        await getGameweekById(req, res, next);

        assert.equal(getStatusCode(), 404);
        assert.equal(getJsonResponse().success, false);
        assert.match(getJsonResponse().message, /Gameweek with ID 42 not found/);
    });

    it("should map authenticated user gameweek history into the expected response shape", async () => {
        const history = [
            {
                id: "score_1",
                points: 80,
                benchPoints: 4,
                captainPoints: 10,
                transferCost: 2,
                gameweek: { id: 1, fplId: 1 },
                squad: {
                    id: "squad_1",
                    players: [
                        {
                            positionOrder: 1,
                            player: { id: "player_1", displayName: "A. Smith", team: { name: "Team A" } },
                        },
                    ],
                },
            },
        ];

        (prisma.squadGameweekScore as any).findMany = async (args: any) => {
            assert.equal(args.where.squad.userId, "user_1");
            assert.deepEqual(args.orderBy, { gameweekId: "asc" });
            return history;
        };

        const { req, res, next, getJsonResponse } = createMockReqRes({
            user: { id: "user_1" },
        });

        await getMyGameweekHistory(req, res, next);

        assert.equal(getJsonResponse().success, true);
        assert.equal(getJsonResponse().data[0].id, "score_1");
        assert.equal(getJsonResponse().data[0].points, 80);
        assert.equal(getJsonResponse().data[0].gameweek.id, 1);
        assert.equal(getJsonResponse().data[0].squad.id, "squad_1");
    });

    it("should reject unauthenticated history requests with 401", async () => {
        const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes({});

        await getMyGameweekHistory(req, res, next);

        assert.equal(getStatusCode(), 401);
        assert.equal(getJsonResponse().success, false);
        assert.match(getJsonResponse().message, /Authentication required/);
    });

    it("should forward prisma errors to the next middleware", async () => {
        const dbError = new Error("Gameweek lookup failed");

        (prisma.gameweek as any).findMany = async () => {
            throw dbError;
        };

        const { req, res, next, getNextError } = createMockReqRes({});

        await getGameweeks(req, res, next);

        assert.equal(getNextError(), dbError);
    });
});
