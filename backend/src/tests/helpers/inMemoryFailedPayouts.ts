import { randomUUID } from "node:crypto";

/**
 * Minimal in-memory stand-in for the Prisma `failedPayout` delegate, supporting the
 * query shapes used by PayoutDeadLetterService (equality, `in`, `lt` and `OR`).
 */

type Row = Record<string, any>;

function matchesCondition(value: any, condition: any): boolean {
  if (condition && typeof condition === "object" && !(condition instanceof Date)) {
    if ("in" in condition) return condition.in.includes(value);
    if ("lt" in condition) return value < condition.lt;
    if ("gt" in condition) return value > condition.gt;
  }
  return value === condition;
}

export function matchesWhere(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some((sub) => matchesWhere(row, sub));
    return matchesCondition(row[key], condition);
  });
}

export function createInMemoryFailedPayouts() {
  const rows: Row[] = [];

  return {
    rows,
    create: async ({ data }: { data: Row }) => {
      const now = new Date();
      const row = { id: randomUUID(), createdAt: now, updatedAt: now, resolvedAt: null, ...data };
      rows.push(row);
      return { ...row };
    },
    findMany: async ({ where, orderBy, take, skip }: Row = {}) => {
      let result = rows.filter((r) => matchesWhere(r, where));
      if (orderBy?.createdAt) {
        const dir = orderBy.createdAt === "desc" ? -1 : 1;
        result = [...result].sort((a, b) => dir * (a.createdAt - b.createdAt));
      }
      return result.slice(skip ?? 0, take ? (skip ?? 0) + take : undefined).map((r) => ({ ...r }));
    },
    findUnique: async ({ where }: Row) => {
      const row = rows.find((r) => r.id === where.id);
      return row ? { ...row } : null;
    },
    count: async ({ where }: Row = {}) => rows.filter((r) => matchesWhere(r, where)).length,
    update: async ({ where, data }: Row) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error(`failedPayout ${where.id} not found`);
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
    updateMany: async ({ where, data }: Row) => {
      const matched = rows.filter((r) => matchesWhere(r, where));
      matched.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }));
      return { count: matched.length };
    },
  };
}
