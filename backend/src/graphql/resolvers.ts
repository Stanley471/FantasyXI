import DataLoader from "dataloader";
import { prisma } from "../config/db.js";
import { displayUsername, type PrivacyViewer } from "../services/privacy/displayName.js";

export interface GraphQLContext {
  loaders: {
    users: DataLoader<string, Awaited<ReturnType<typeof prisma.user.findMany>>[number] | null>;
    players: DataLoader<number, Awaited<ReturnType<typeof prisma.player.findMany>>[number] | null>;
  };
  /** Signed-in viewer when a Bearer token was presented; undefined when anonymous. */
  viewer?: PrivacyViewer;
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
    /**
     * Anonymous managers show as "Manager #XXXX" to everyone except
     * themselves and platform admins (issue #511). The flag travels on the
     * user record, so this covers users, user, leagues and league alike.
     */
    username: (
      user: { id: string; username: string; isAnonymous?: boolean | null },
      _args: unknown,
      context?: GraphQLContext
    ) =>
      displayUsername(
        { id: user.id, username: user.username, isAnonymous: user.isAnonymous },
        context?.viewer
      ),
    /**
     * The real name is visible only to the manager themselves and platform
     * admins (issue #511); everyone else reads null.
     */
    name: (
      user: { id: string; name?: string | null },
      _args: unknown,
      context?: GraphQLContext
    ) => {
      if (!user.name) return null;
      const viewer = context?.viewer;
      if (viewer && (viewer.id === user.id || viewer.role === "ADMIN")) return user.name;
      return null;
    },
  },
  Player: {
    price: (player: { price: unknown }) => Number(player.price),
  },
  Squad: {
    budgetRemaining: (squad: { budgetRemaining: unknown }) => Number(squad.budgetRemaining),
  },
});

export const resolvers = createResolvers();
