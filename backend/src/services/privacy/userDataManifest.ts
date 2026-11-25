import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

type Model = (typeof Prisma.dmmf.datamodel.models)[number];
type Database = Record<string, any>;
const delegate = (model: Model) => model.name[0].toLowerCase() + model.name.slice(1);
const secret = /password|token|privateKey|secret|codeHash|signature/i;

function sanitize(value: any, userId: string, userFields: string[] = []): any {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(item => sanitize(item, userId));
  if (typeof value === "object") {
    if (typeof value.toJSON === "function") return value.toJSON();
    return Object.fromEntries(Object.entries(value).filter(([key]) => !secret.test(key)).map(([key,item]) => [key, userFields.includes(key) && item && item !== userId ? "[other user]" : sanitize(item,userId)]));
  }
  return value;
}

export function ownerFields(model: Model): string[] {
  return [...new Set([
    ...model.fields.filter(field => field.kind === "object" && field.type === "User").flatMap(field => [...(field.relationFromFields ?? [])]),
    ...model.fields.filter(field => field.name === "userId").map(field => field.name),
  ])];
}

/** Every Prisma table is classified; relational descendants are fetched only through owned squads. */
export async function collectUserManifest(db: Database, userId: string, models: readonly Model[] = Prisma.dmmf.datamodel.models) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("Account not found");
  const squads = await db.squad.findMany({ where: { userId }, select: { id: true } });
  const squadIds = squads.map((s: { id: string }) => s.id);
  const memberships = models.some(model=>model.name==="LeagueMember") ? await db.leagueMember.findMany({ where:{ userId },select:{ id:true } }) : [];
  const memberIds = memberships.map((row:{id:string})=>row.id);
  const wallets = models.some(model=>model.name==="Wallet") ? await db.wallet.findMany({ where:{ userId },select:{stellarAddress:true} }) : [];
  const addresses = wallets.map((row:{stellarAddress:string})=>row.stellarAddress);
  const transactions = models.some(model=>model.name==="Transaction") ? await db.transaction.findMany({ where:{userId},select:{stellarTxHash:true},take:50001 }) : [];
  if(transactions.length>50000) throw new Error("Export requires operator assistance");
  const hashes=transactions.map((row:{stellarTxHash:string|null})=>row.stellarTxHash).filter(Boolean);
  const tables: Record<string, { classification: string; records: any[]; sha256: string }> = {};
  let totalBytes = 0;
  for (const model of models) {
    const owner = ownerFields(model);
    let where: any, classification = "shared reference or operational data; no direct user ownership";
    if (model.name === "User") { where = { id: userId }; classification = "own profile"; }
    else if (owner.length) { where = { OR: owner.map(field => ({ [field]: userId })) }; classification = "user-linked records"; }
    else if (["FinancialAuditLog", "CoordinatedTransaction"].includes(model.name)) { where = { userId }; classification = "own financial evidence"; }
    else if (model.name === "CryptoAuditLogEntry") { where = { actorId: userId }; classification = "own action metadata"; }
    else if (model.name === "FailedPayout") { where = { memberIds:{hasSome:memberIds} }; classification = "own payout slices"; }
    else if (model.name === "DepositException") { where = { senderAddress:{in:addresses} }; classification = "own deposit exceptions"; }
    else if (model.name === "ContractEvent") { where = { txHash:{in:hashes} }; classification = "public ledger event metadata for own transactions"; }
    else if (model.fields.some(field => field.name === "squadId")) { where = { squadId: { in: squadIds } }; classification = "own squad descendants"; }
    else {
      const privateParent = model.fields.find(field => field.kind === "object" && field.type === "MatchRating");
      if (privateParent) { where = { [privateParent.name]: { is: { userId } } }; classification = "own rating history"; }
    }
    let records: any[] = [];
    if (where) {
      // Scalar-only selection never expands a relation into another user's rows.
      const select = Object.fromEntries(model.fields.filter(field => field.kind !== "object" && !secret.test(field.name)).map(field => [field.name,true]));
      const rows = await db[delegate(model)].findMany({ where, select, take: 50_001 });
      if (rows.length > 50_000) throw new Error("Export exceeds bounded worker capacity; operator-assisted export required");
      records = rows.map((row: any) => sanitize(row,userId,owner));
      if(model.name==="FailedPayout") records=records.map(row=>{
        const indices=(row.memberIds as string[]).flatMap((id,index)=>memberIds.includes(id)?[index]:[]);
        return {...row,memberIds:indices.map(index=>row.memberIds[index]),recipients:indices.map(index=>row.recipients[index]),errorMessage:undefined,resolutionNote:undefined};
      });
      if(model.name==="ContractEvent") records=records.map(({payload,...row})=>row);
      if(model.name==="PrivacyJob") records=records.map(({publicKey,objectKey,...row})=>row);
      // Shared security evidence can contain other actors' private notes/payloads.
      if (["CryptoAuditLogEntry", "LeagueCollusionFlag", "SuspensionAppeal"].includes(model.name)) records = records.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !["payload","signals","evidencePayload","reviewNote","reason","detail","dismissalReason","suspensionReason"].includes(key))));
    }
    const bytes = JSON.stringify(records); totalBytes += Buffer.byteLength(bytes);
    if (totalBytes > 50_000_000) throw new Error("Export exceeds bounded worker capacity; operator-assisted export required");
    tables[model.dbName ?? model.name] = { classification, records, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  return { version: 1, subject: userId, generatedAt: new Date().toISOString(), omissions: ["Password hashes and authentication secrets", "Other users' identities and private security-review payloads"], tables };
}

/** Keep pseudonymous financial/game history; destroy credentials and personal records. */
export async function eraseUserData(db: Database, userId: string, models: readonly Model[] = Prisma.dmmf.datamodel.models) {
  const retained = new Set(["User","Transaction","LeagueMember","League","Squad","FinancialAuditLog","CoordinatedTransaction","DepositRefundClaim","LeagueCollusionFlag","SuspensionAppeal","LeagueInvitation","MatchmakingQueueEntry","PrivacyJob","PrivacyErasedAccount"]);
  for (const model of [...models].reverse()) {
    const owner = ownerFields(model);
    if (!owner.length || retained.has(model.name)) continue;
    await db[delegate(model)].deleteMany({ where: { OR: owner.map(field => ({ [field]: userId })) } });
  }
  if (models.some(model=>model.name==="LeagueInvitation")) {
    await db.leagueInvitation.deleteMany({ where:{ createdById:userId } });
    await db.leagueInvitation.updateMany({ where:{ usedById:userId },data:{ usedById:null } });
  }
  if (models.some(model=>model.name==="MatchmakingQueueEntry")) {
    await db.matchmakingQueueEntry.deleteMany({ where:{ userId } });
    await db.matchmakingQueueEntry.updateMany({ where:{ matchedUserId:userId },data:{ matchedUserId:null,matchedAt:null,status:"QUEUED" } });
  }
  if (models.some(model=>model.name==="LeagueCollusionFlag")) {
    await db.leagueCollusionFlag.updateMany({ where:{ OR:[{accountAId:userId},{accountBId:userId}] },data:{ evidencePayload:{ erasedSubject:true },reviewNote:null,dismissalReason:null,suspensionReason:null } });
    await db.suspensionAppeal.updateMany({ where:{ accountId:userId },data:{ reason:"Erased account",reviewNote:null } });
  }
  await db.squad.updateMany({ where: { userId }, data: { name: "Deleted manager" } });
  await db.league.updateMany({ where: { creatorId: userId }, data: { name: "Deleted manager league", description: null } });
  await db.user.update({ where: { id: userId }, data: { email: `deleted-${userId}@deleted.invalid`, username: `deleted-${userId}`, name: null, passwordHash: null, googleId: null, countryCode: null, referralCode: null, referrerId: null, role: "USER" } });
}
