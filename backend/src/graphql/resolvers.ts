import DataLoader from "dataloader";
import { prisma } from "../config/db.js";

export interface GraphQLContext {
  loaders: {
    users: DataLoader<string, Awaited<ReturnType<typeof prisma.user.findMany>>[number] | null>;
    players: DataLoader<number, Awaited<ReturnType<typeof prisma.player.findMany>>[number] | null>;
  };
}

const userInclude = {
  wallet: true,
  squads: { include: { players: { include: { player: { include: { team: true } } } } } },
  createdLeagues: { include: { members: { include: { user: true, squad: true } } } },
} as const;

const playerInclude = { team: true } as const;

export const createResolvers = (database: typeof prisma = prisma) => ({
  Query: {
    users: (_parent: unknown, args: { limit?: number }) =>
      database.user.findMany({ take: Math.min(args.limit ?? 50, 100), include: userInclude }),
    user: (_parent: unknown, args: { id: string }, context: GraphQLContext) =>
      context.loaders.users.load(args.id),
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
    league: (_parent: unknown, args: { id: string }) =>
      database.league.findUnique({
        where: { id: args.id },
        include: { creator: true, members: { include: { user: true, squad: true } } },
      }),
  },
  User: {
    countryCode: (user: { countryCode?: string | null }) => user.countryCode,
  },
  Player: {
    price: (player: { price: unknown }) => Number(player.price),
  },
  Squad: {
    budgetRemaining: (squad: { budgetRemaining: unknown }) => Number(squad.budgetRemaining),
  },
});

export const resolvers = createResolvers();
