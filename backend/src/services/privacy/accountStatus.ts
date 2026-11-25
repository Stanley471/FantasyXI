import { prisma } from "../../config/db.js";
type Resolver = (userId: string) => boolean | Promise<boolean>;
const databaseResolver: Resolver = async userId => {
  const result = await prisma.$queryRaw<{ erased: boolean }[]>`SELECT EXISTS(SELECT 1 FROM privacy_erased_accounts WHERE user_id=${userId}) AS erased`;
  return result[0].erased;
};
let resolver: Resolver = databaseResolver;
export const accountErased = (userId: string) => resolver(userId);
/** Unit tests without a database can explicitly supply their active-account fixture. */
export function setAccountStatusResolver(value: Resolver | null) { resolver = value ?? databaseResolver; }
