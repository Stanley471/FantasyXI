import assert from "node:assert/strict";
import test from "node:test";
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { encryptExport, validateExportKey } from "../services/privacy/exportEncryption.js";
import { collectUserManifest, eraseUserData } from "../services/privacy/userDataManifest.js";

test("encrypted export round-trips only with the recipient key; tampering fails authentication", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = keys.publicKey.export({ type:"spki",format:"pem" }).toString();
  const plaintext = Buffer.from(JSON.stringify({ tables: { users: [{ id:"synthetic-user", name:"private synthetic name" }] } }));
  const original = Buffer.from(plaintext); const encrypted = encryptExport(plaintext,pem);
  assert.ok(!encrypted.includes("private synthetic name")); assert.ok(plaintext.every(byte=>byte===0));
  const envelope = JSON.parse(encrypted.toString());
  const key = privateDecrypt({ key:keys.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256" },Buffer.from(envelope.wrappedKey,"base64"));
  const decode = (tag: Buffer) => {
    const decipher = createDecipheriv("aes-256-gcm",key,Buffer.from(envelope.iv,"base64"));
    decipher.setAAD(Buffer.from(envelope.aad,"base64")); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64")),decipher.final()]);
  };
  assert.deepEqual(decode(Buffer.from(envelope.tag,"base64")),original);
  assert.throws(()=>decode(Buffer.alloc(16)));
  assert.throws(()=>validateExportKey(keys.privateKey.export({ type:"pkcs8",format:"pem" })));
  assert.throws(()=>validateExportKey("not a key"));
});

const models = [
  { name:"User",dbName:"users",fields:[{ name:"id",kind:"scalar" },{ name:"email",kind:"scalar" },{ name:"passwordHash",kind:"scalar" }] },
  { name:"Squad",dbName:"squads",fields:[{ name:"id",kind:"scalar" },{ name:"userId",kind:"scalar" },{ name:"user",kind:"object",type:"User",relationFromFields:["userId"] }] },
  { name:"SquadPlayer",dbName:"squad_players",fields:[{ name:"id",kind:"scalar" },{ name:"squadId",kind:"scalar" }] },
  { name:"SharedReference",dbName:"shared_reference",fields:[{ name:"id",kind:"scalar" }] },
] as any;

test("manifest covers every model, queries only owned rows, excludes secrets and does not expand relations", async () => {
  const calls: any[] = [];
  const db = {
    user: { findUnique: async()=>({ id:"alice" }),findMany:async(args:any)=>{ calls.push(args);return [{ id:"alice",email:"alice@example.test",passwordHash:"must-not-export" }]; } },
    squad: { findMany:async(args:any)=>{ calls.push(args);return [{ id:"squad-a",userId:"alice" }]; } },
    squadPlayer:{findMany:async(args:any)=>{ calls.push(args);return [{ id:"owned-player",squadId:"squad-a" }]; } },
  };
  const manifest = await collectUserManifest(db,"alice",models);
  assert.deepEqual(Object.keys(manifest.tables).sort(),["shared_reference","squad_players","squads","users"]);
  assert.ok(!JSON.stringify(manifest).includes("must-not-export"));
  assert.ok(calls.some(call=>call.where?.squadId?.in?.includes("squad-a")));
  for(const call of calls) assert.equal(call.include,undefined);
  assert.deepEqual(manifest.tables.shared_reference.records,[]);
});

test("erasure removes own personal rows and credentials while retaining pseudonymous financial relationships", async()=>{
  const calls:any[]=[];
  const db:any={
    wallet:{deleteMany:async(args:any)=>{calls.push(["wallet",args]);}},
    squad:{updateMany:async(args:any)=>{calls.push(["squad",args]);}},
    league:{updateMany:async(args:any)=>{calls.push(["league",args]);}},
    user:{update:async(args:any)=>{calls.push(["user",args]);}},
  };
  const erasureModels:any=[{name:"Wallet",fields:[{name:"userId",kind:"scalar"}]},{name:"Transaction",fields:[{name:"userId",kind:"scalar"}]}];
  await eraseUserData(db,"alice",erasureModels);
  assert.equal(calls[0][0],"wallet");assert.deepEqual(calls[0][1].where,{OR:[{userId:"alice"}]});
  const user=calls.find(call=>call[0]==="user")[1];
  assert.equal(user.data.passwordHash,null);assert.equal(user.data.googleId,null);assert.equal(user.data.name,null);
  assert.equal(user.data.email,"deleted-alice@deleted.invalid");
  assert.ok(!calls.some(call=>call[0]==="transaction"));
});
