/**
 * L3 fallback tier for the FPL client (issue #275): the last good payload of
 * every FPL endpoint, persisted in PostgreSQL.
 *
 * Served only when the upstream API is failing and both the in-memory and
 * Redis tiers are empty (e.g. a cold restart during an FPL outage). There is
 * one row per endpoint, so storage is O(E) with E ~ 80 distinct endpoints
 * (bootstrap, fixtures, one live payload per gameweek), and each read or write
 * is a single primary-key lookup.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";

export interface FplSnapshot {
  payload: unknown;
  fetchedAt: Date;
}

export interface FplSnapshotStore {
  save(endpoint: string, payload: unknown): Promise<void>;
  load(endpoint: string): Promise<FplSnapshot | null>;
}

export const prismaFplSnapshotStore: FplSnapshotStore = {
  async save(endpoint, payload) {
    const data = { payload: payload as Prisma.InputJsonValue, fetchedAt: new Date() };
    await prisma.fplApiSnapshot.upsert({
      where: { endpoint },
      create: { endpoint, ...data },
      update: data,
    });
  },

  load(endpoint) {
    return prisma.fplApiSnapshot.findUnique({
      where: { endpoint },
      select: { payload: true, fetchedAt: true },
    });
  },
};
