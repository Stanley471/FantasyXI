import crypto from "crypto";

/**
 * Small in-memory stand-in for the Prisma client, used by service tests that
 * need realistic multi-table behaviour: filtering, ordering, includes, unique
 * constraints and interactive transactions that roll back on error.
 * Only the query features used by the services under test are supported.
 */

type Row = Record<string, any>;

export interface InMemoryPrismaOptions {
  /** Compound or single unique keys per model, e.g. { swissTournament: [["leagueId", "seasonNumber"]] } */
  uniques?: Record<string, string[][]>;
  /** Relations resolvable through `include` / `select`: model -> field -> target */
  relations?: Record<string, Record<string, { model: string; foreignKey: string; many?: boolean; references?: string }>>;
  /** Default values applied on create */
  defaults?: Record<string, Row | (() => Row)>;
}

export class UniqueConstraintError extends Error {
  code = "P2002";
  constructor(model: string, fields: string[]) {
    super(`Unique constraint failed on ${model}(${fields.join(", ")})`);
  }
}

function matchesCondition(value: any, condition: any): boolean {
  if (condition === null || typeof condition !== "object" || condition instanceof Date) {
    return value instanceof Date && condition instanceof Date
      ? value.getTime() === condition.getTime()
      : value === condition;
  }
  if ("in" in condition && !condition.in.includes(value)) return false;
  if ("notIn" in condition && condition.notIn.includes(value)) return false;
  if ("not" in condition && matchesCondition(value, condition.not)) return false;
  if ("equals" in condition && !matchesCondition(value, condition.equals)) return false;
  const cmp = (x: any) => (x instanceof Date ? x.getTime() : x);
  if ("gt" in condition && !(value !== null && cmp(value) > cmp(condition.gt))) return false;
  if ("gte" in condition && !(value !== null && cmp(value) >= cmp(condition.gte))) return false;
  if ("lt" in condition && !(value !== null && cmp(value) < cmp(condition.lt))) return false;
  if ("lte" in condition && !(value !== null && cmp(value) <= cmp(condition.lte))) return false;
  return true;
}

function matchesWhere(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Row[]).every((w) => matchesWhere(row, w));
    if (key === "OR") return (condition as Row[]).some((w) => matchesWhere(row, w));
    if (condition && typeof condition === "object" && !(condition instanceof Date) && !Array.isArray(condition)) {
      const isOperator = Object.keys(condition).some((k) =>
        ["in", "notIn", "not", "equals", "gt", "gte", "lt", "lte"].includes(k)
      );
      // Compound unique selector such as { leagueId_userId: { leagueId, userId } }
      if (!isOperator && key.includes("_") && !(key in row)) return matchesWhere(row, condition);
    }
    return matchesCondition(row[key], condition);
  });
}

function compare(a: Row, b: Row, orderBy: Row | Row[] | undefined): number {
  const orders = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  for (const order of orders) {
    for (const [key, direction] of Object.entries(order)) {
      const x = a[key] instanceof Date ? a[key].getTime() : a[key];
      const y = b[key] instanceof Date ? b[key].getTime() : b[key];
      if (x === y) continue;
      const result = x < y ? -1 : 1;
      return direction === "desc" ? -result : result;
    }
  }
  return 0;
}

export function createInMemoryPrisma(options: InMemoryPrismaOptions = {}) {
  let tables: Record<string, Row[]> = {};
  const table = (model: string) => (tables[model] ??= []);

  const project = (model: string, row: Row, args: Row = {}): Row => {
    const shape = args.select ?? args.include;
    if (!shape) return { ...row };
    const out: Row = args.select ? {} : { ...row };
    for (const [field, spec] of Object.entries(shape)) {
      if (!spec) continue;
      const relation = options.relations?.[model]?.[field];
      if (!relation) {
        if (args.select) out[field] = row[field];
        continue;
      }
      const nested = typeof spec === "object" ? (spec as Row) : {};
      if (relation.many) {
        const related = table(relation.model)
          .filter((r) => r[relation.foreignKey] === row[relation.references ?? "id"])
          .filter((r) => matchesWhere(r, nested.where))
          .sort((x, y) => compare(x, y, nested.orderBy));
        out[field] = related.map((r) => project(relation.model, r, nested));
      } else {
        const target = table(relation.model).find((r) => r[relation.references ?? "id"] === row[relation.foreignKey]);
        out[field] = target ? project(relation.model, target, nested) : null;
      }
    }
    return out;
  };

  const assertUnique = (model: string, candidate: Row, ignore?: Row) => {
    const keys = [["id"], ...(options.uniques?.[model] ?? [])];
    for (const fields of keys) {
      if (fields.some((f) => candidate[f] === undefined || candidate[f] === null)) continue;
      const clash = table(model).find(
        (row) => row !== ignore && fields.every((f) => row[f] === candidate[f])
      );
      if (clash) throw new UniqueConstraintError(model, fields);
    }
  };

  const applyData = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value)) {
        if ("increment" in value) row[key] = (row[key] ?? 0) + value.increment;
        else if ("decrement" in value) row[key] = (row[key] ?? 0) - value.decrement;
        else if ("set" in value) row[key] = value.set;
        else row[key] = value;
      } else {
        row[key] = value;
      }
    }
    if ("updatedAt" in row) row.updatedAt = new Date();
  };

  const delegate = (model: string) => ({
    findUnique: async (args: Row) => {
      const row = table(model).find((r) => matchesWhere(r, args.where));
      return row ? project(model, row, args) : null;
    },
    findFirst: async (args: Row = {}) => {
      const row = table(model)
        .filter((r) => matchesWhere(r, args.where))
        .sort((a, b) => compare(a, b, args.orderBy))[0];
      return row ? project(model, row, args) : null;
    },
    findMany: async (args: Row = {}) => {
      let rows = table(model)
        .filter((r) => matchesWhere(r, args.where))
        .sort((a, b) => compare(a, b, args.orderBy));
      if (args.skip) rows = rows.slice(args.skip);
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map((r) => project(model, r, args));
    },
    count: async (args: Row = {}) => table(model).filter((r) => matchesWhere(r, args.where)).length,
    create: async (args: Row) => {
      const defaults = options.defaults?.[model];
      const row: Row = {
        id: crypto.randomUUID(),
        ...(typeof defaults === "function" ? defaults() : defaults ?? {}),
        ...args.data,
      };
      assertUnique(model, row);
      table(model).push(row);
      return project(model, row, args);
    },
    createMany: async (args: Row) => {
      let count = 0;
      for (const data of args.data as Row[]) {
        const defaults = options.defaults?.[model];
        const row: Row = { id: crypto.randomUUID(), ...(typeof defaults === "function" ? defaults() : defaults ?? {}), ...data };
        try {
          assertUnique(model, row);
        } catch (error) {
          if (args.skipDuplicates) continue;
          throw error;
        }
        table(model).push(row);
        count++;
      }
      return { count };
    },
    update: async (args: Row) => {
      const row = table(model).find((r) => matchesWhere(r, args.where));
      if (!row) throw Object.assign(new Error(`${model} not found`), { code: "P2025" });
      const next = { ...row };
      applyData(next, args.data);
      assertUnique(model, next, row);
      Object.assign(row, next);
      return project(model, row, args);
    },
    updateMany: async (args: Row) => {
      const rows = table(model).filter((r) => matchesWhere(r, args.where));
      rows.forEach((row) => applyData(row, args.data));
      return { count: rows.length };
    },
    delete: async (args: Row) => {
      const index = table(model).findIndex((r) => matchesWhere(r, args.where));
      if (index === -1) throw Object.assign(new Error(`${model} not found`), { code: "P2025" });
      return table(model).splice(index, 1)[0];
    },
    deleteMany: async (args: Row = {}) => {
      const keep = table(model).filter((r) => !matchesWhere(r, args.where));
      const count = table(model).length - keep.length;
      tables[model] = keep;
      return { count };
    },
  });

  const client: Row = new Proxy(
    {
      /** Interactive transaction: state is restored if `fn` throws. */
      $transaction: async (fn: any) => {
        if (Array.isArray(fn)) return Promise.all(fn);
        const snapshot = structuredClone(tables);
        try {
          return await fn(client);
        } catch (error) {
          tables = snapshot;
          throw error;
        }
      },
      /** Direct access to the stored rows, for seeding and assertions. */
      $tables: () => tables,
      $seed: (model: string, rows: Row[]) => {
        for (const row of rows) table(model).push({ ...row });
      },
    },
    {
      get(target: Row, prop: string) {
        if (prop in target) return target[prop];
        if (typeof prop !== "string" || prop.startsWith("$") || prop === "then") return undefined;
        return (target[prop] ??= delegate(prop));
      },
    }
  );
  return client as any;
}
