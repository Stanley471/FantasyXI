import DataLoader from "dataloader";
import { prisma } from "../config/db.js";
import { GraphQLError } from "graphql";
import { Permission, hasPermission, type Role } from "../config/permissions.js";
import { recordPermissionDenial } from "../services/security/authorizationTelemetry.js";

export interface GraphQLContext {
  principal?: { id: string; role: Role } | null;
  loaders: {
    users: DataLoader<string, Awaited<ReturnType<typeof prisma.user.findMany>>[number] | null>;
    players: DataLoader<number, Awaited<ReturnType<typeof prisma.player.findMany>>[number] | null>;
  };
}

function authorize(context: GraphQLContext | undefined, ownerId?: string) {
  const user = context?.principal;
  if (user && ((ownerId && ownerId === user.id) || hasPermission(user.role, Permission.SECURITY_REVIEW))) return;
  recordPermissionDenial({ user: user ? { ...user, email: "", username: "" } : undefined, ip: undefined, method: "GRAPHQL", path: "protected-field" }, "ownership", [Permission.SECURITY_REVIEW]);
  throw new GraphQLError("Access denied.", { extensions: { code: "FORBIDDEN", http: { status: 403 } } });
}

const userInclude = {
  wallet: true,
  squads: { include: { players: { include: { player: { include: { team: true } } } } } },
  createdLeagues: { include: { members: { include: { user: true, squad: true } } } },
} as const;

const playerInclude = { team: true } as const;

export const createResolvers = (database: typeof prisma = prisma) => ({
  Query: {
    users: (_parent: unknown, args: { limit?: number }, context?: GraphQLContext) => {
      authorize(context);
      return database.user.findMany({ take: Math.min(args.limit ?? 50, 100), include: userInclude });
    },
    user: (_parent: unknown, args: { id: string }, context: GraphQLContext) => {
      authorize(context, args.id);
      return context.loaders.users.load(args.id);
    },
    players: (_parent: unknown, args: { limit?: number }) =>
      database.player.findMany({ take: Math.min(args.limit ?? 100, 500), include: playerInclude }),
    player: (_parent: unknown, args: { id: string }, context: GraphQLContext) =>
      context.loaders.players.load(Number(args.id)),
    leagues: (_parent: unknown, args: { limit?: number }) =>
      database.league.findMany({
        // Private leagues are invitation-only and never listed publicly
        where: { isPrivate: false },
        take: Math.min(args.limit ?? 50, 100),
        include: { creator: true, members: { include: { user: true, squad: true } } },
      }),
    league: async (_parent: unknown, args: { id: string }, context?: GraphQLContext) => {
      const league = await database.league.findUnique({
        where: { id: args.id },
        include: { creator: true, members: { include: { user: true, squad: true } } },
      });
      if (league && league.isPrivate !== false) {
        const member = league.members.some(m => m.userId === context?.principal?.id);
        authorize(context, member ? context?.principal?.id : league.creatorId);
      }
      return league;
    },
  },
  User: {
    wallet: (user: { id: string; wallet?: unknown }, _args: unknown, context: GraphQLContext) => { authorize(context, user.id); return user.wallet; },
    squads: (user: { id: string; squads?: unknown }, _args: unknown, context: GraphQLContext) => { authorize(context, user.id); return user.squads; },
    createdLeagues: (user: { id: string; createdLeagues?: unknown }, _args: unknown, context: GraphQLContext) => { authorize(context, user.id); return user.createdLeagues; },
    countryCode: (user: { countryCode?: string | null }) => user.countryCode,
  },
  Player: {
    price: (player: { price: unknown }) => Number(player.price),
  },
  Squad: {
    players: (squad: { userId: string; players?: unknown }, _args: unknown, context: GraphQLContext) => { authorize(context, squad.userId); return squad.players; },
    budgetRemaining: (squad: { budgetRemaining: unknown }) => Number(squad.budgetRemaining),
  },
});

export const resolvers = createResolvers();
