import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from "node:crypto";
import { prisma } from "../config/db.js";
import { PrivacyService } from "../services/privacy/privacyService.js";
import { accountErased } from "../services/privacy/accountStatus.js";

const url=process.env.FANTASY_TEST_DATABASE_URL;
test("PostgreSQL export/erasure isolates users, encrypts archives, revokes access and preserves financial history",{skip:!url},async()=>{
  const location=new URL(url!);assert.equal(location.hostname,"127.0.0.1");assert.ok(["/fantasy_454","/fantasy_combined"].includes(location.pathname));
  assert.equal(process.env.DATABASE_URL,url);
  const id=randomUUID(),other=randomUUID();
  const objects=new Map<string,Buffer>();const deleted:string[]=[];let failUpload=true;
  const storage={put:async(key:string,body:Buffer)=>{if(failUpload)throw new Error("synthetic storage outage");objects.set(key,Buffer.from(body));},link:async(_key:string,expiry:Date)=>`https://download.example.test/?expires=${expiry.getTime()}`,delete:async(key:string)=>{objects.delete(key);deleted.push(key);}};
  const service=new PrivacyService(prisma,storage);
  const keypair=generateKeyPairSync("rsa",{modulusLength:2048});
  const publicKey=keypair.publicKey.export({type:"spki",format:"pem"}).toString();
  try{
    for(const userId of [id,other]) await prisma.user.create({data:{id:userId,email:`${userId}@example.test`,username:userId,name:userId===id?"Own synthetic name":"Other private name",passwordHash:"never-export-this-hash"}});
    await prisma.wallet.create({data:{userId:id,stellarAddress:`synthetic-${id}`}});
    await prisma.squad.create({data:{userId:id,name:"Own private squad"}});
    await prisma.squad.create({data:{userId:other,name:"Other private squad"}});
    const gameweek=await prisma.gameweek.create({data:{fplId:Math.floor(Math.random()*1_000_000_000)+1_000_000,name:"Synthetic privacy gameweek",deadline:new Date(),season:"2026/27"}});
    const league=await prisma.league.create({data:{creatorId:id,name:"Synthetic privacy league",inviteCode:randomUUID(),startGameweekId:gameweek.id,endGameweekId:gameweek.id}});
    await prisma.leagueChatMessage.create({data:{leagueId:league.id,userId:id,body:"Own private chat body"}});
    await prisma.leagueChatMessage.create({data:{leagueId:league.id,userId:other,body:"Other private chat body"}});
    const transaction=await prisma.transaction.create({data:{userId:id,type:"ENTRY_FEE",amount:"12.50",status:"CONFIRMED"}});
    const exportJob=await service.request(id,"EXPORT",publicKey);
    assert.equal(await service.status(other,exportJob.id),null);
    await assert.rejects(()=>service.runNext(),/Privacy job failed/);
    assert.equal((await service.status(id,exportJob.id))?.status,"PENDING");assert.equal(objects.size,0);
    failUpload=false;await service.runNext();
    const status=await service.status(id,exportJob.id);assert.equal(status?.status,"DONE");assert.ok(status?.downloadUrl);
    const envelope=JSON.parse([...objects.values()][0].toString());
    const aes=privateDecrypt({key:keypair.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.from(envelope.wrappedKey,"base64"));
    const decipher=createDecipheriv("aes-256-gcm",aes,Buffer.from(envelope.iv,"base64"));decipher.setAAD(Buffer.from(envelope.aad,"base64"));decipher.setAuthTag(Buffer.from(envelope.tag,"base64"));
    const data=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64")),decipher.final()]).toString();
    assert.ok(data.includes("Own private squad"));assert.ok(!data.includes("Other private squad"));assert.ok(!data.includes("Other private name"));assert.ok(!data.includes("never-export-this-hash"));
    assert.ok(data.includes("Own private chat body"));assert.ok(!data.includes("Other private chat body"));
    assert.ok(JSON.parse(data).tables.transactions.records.some((row:{id:string})=>row.id===transaction.id));
    // Expired jobs cannot acquire fresh download links.
    await prisma.$executeRaw`UPDATE privacy_jobs SET expires_at=now()-interval '1 second' WHERE id=${exportJob.id}::uuid`;
    assert.equal((await service.status(id,exportJob.id))?.downloadUrl,undefined);
    const eraseJob=await service.request(id,"ERASE");await service.runNext();
    assert.equal((await service.status(id,eraseJob.id))?.status,"DONE");assert.equal(await accountErased(id),true);
    const user=await prisma.user.findUniqueOrThrow({where:{id}});assert.equal(user.passwordHash,null);assert.equal(user.name,null);assert.ok(user.email.endsWith("@deleted.invalid"));
    assert.equal(await prisma.wallet.count({where:{userId:id}}),0);
    assert.equal(await prisma.leagueChatMessage.count({where:{userId:id}}),0);
    assert.equal(await prisma.leagueChatMessage.count({where:{userId:other,leagueId:league.id}}),1);
    assert.ok(await prisma.transaction.findUnique({where:{id:transaction.id}}));
    assert.equal((await prisma.user.findUniqueOrThrow({where:{id:other}})).name,"Other private name");
    assert.equal(objects.size,0);assert.ok(deleted.length);
  }finally{
    // Synthetic database only. Retained anonymized financial evidence is intentional.
    await prisma.$disconnect();
  }
});
