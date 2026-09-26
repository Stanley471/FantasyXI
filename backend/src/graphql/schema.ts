export const typeDefs = /* GraphQL */ `
  type User {
    id: ID!
    username: String!
    name: String
    countryCode: String
    wallet: Wallet
    squads: [Squad!]!
    createdLeagues: [League!]!
  }

  type Wallet {
    id: ID!
    stellarAddress: String!
  }

  type Team {
    id: ID!
    name: String!
    shortName: String!
  }

  type Player {
    id: ID!
    fplId: Int!
    displayName: String!
    position: String!
    price: Float!
    totalPoints: Int!
    team: Team!
  }

  type Squad {
    id: ID!
    name: String!
    totalPoints: Int!
    budgetRemaining: Float!
    players: [SquadPlayer!]!
  }

  type SquadPlayer {
    id: ID!
    player: Player!
    isCaptain: Boolean!
    isViceCaptain: Boolean!
    isStarter: Boolean!
    positionOrder: Int!
  }

  type League {
    id: ID!
    name: String!
    description: String
    status: String!
    scoringType: String!
    currentMembers: Int!
    members: [LeagueMember!]!
    creator: User!
  }

  type LeagueMember {
    id: ID!
    status: String!
    totalPoints: Int!
    rank: Int
    user: User!
    squad: Squad!
  }

  type Query {
    users(limit: Int = 50): [User!]!
    user(id: ID!): User
    players(limit: Int = 100): [Player!]!
    player(id: ID!): Player
    leagues(limit: Int = 50): [League!]!
    league(id: ID!): League
  }
`;
