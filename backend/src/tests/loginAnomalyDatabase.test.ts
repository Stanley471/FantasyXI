import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../config/db.js";
import { LoginSecurityService } from "../services/security/loginSecurityService.js";
import { loginActivityStore,readOwnSecurityActivity } from "../services/security/loginActivityStore.js";
import { AuthService } from "../services/auth/authService.js";

const url=process.env.FANTASY_TEST_DATABASE_URL;
test("login holds issue no token, successful email verification persists trusted location and own history",{skip:!url},async()=>{
  const location=new URL(url!);assert.equal(location.hostname,"127.0.0.1");assert.ok(["/fantasy_453","/fantasy_combined"].includes(location.pathname));assert.equal(process.env.DATABASE_URL,url);
  let now=Date.now();const messages:string[]=[];const id=randomUUID(),other=randomUUID();
  const security=new LoginSecurityService({redis:null,anomalyChallenges:true,activity:loginActivityStore,now:()=>now,travelPolicy:{maxSpeedKmh:800,toleranceKm:0},mailer:{send:async message=>{messages.push(message.text);}}});
  const auth=new AuthService(prisma,undefined,security);
  const email=`${id}@example.test`;
  try{
    await prisma.user.create({data:{id,email,username:id,googleId:`synthetic-${id}`,passwordHash:await bcrypt.hash("Synthetic-test-password-123",4)}});
    const input={email,password:"Synthetic-test-password-123",deviceFingerprint:"synthetic-device-fingerprint"};
    const first=await auth.login(input,{ip:"198.51.100.1",location:{latitude:51.5,longitude:0}});
    assert.ok("token" in first);
    now+=15*60_000;
    const held=await auth.login(input,{ip:"198.51.100.2",location:{latitude:35.68,longitude:139.69}});
    assert.ok("challengeRequired" in held);assert.ok(!("token" in held));assert.ok(!("refreshToken" in held));
    if(!("challengeId" in held))throw new Error("Expected email challenge");
    const code=messages[0].match(/code is: (\d{6})/)![1];
    const verified=await auth.verifyLoginChallenge({challengeId:held.challengeId,code});assert.ok(verified.token);
    const trusted=await prisma.$queryRaw<{count:bigint}[]>`SELECT count(*) AS count FROM login_trusted_locations WHERE user_id=${id}`;assert.equal(trusted[0].count,1n);
    const history=await readOwnSecurityActivity(id) as {outcome:string}[];assert.ok(history.some(row=>row.outcome==="IMPOSSIBLE_TRAVEL"));assert.ok(history.some(row=>row.outcome==="VERIFIED"));
    assert.deepEqual(await readOwnSecurityActivity(other),[]);
    await assert.rejects(()=>auth.verifyLoginChallenge({challengeId:held.challengeId,code}));
    now+=15*60_000;
    const googleHeld=await auth.handleGoogleAuth({googleId:`synthetic-${id}`,email,emailVerified:true},{ip:"198.51.100.3",location:{latitude:51.5,longitude:0}});
    assert.ok("challengeRequired" in googleHeld);assert.ok(!("token" in googleHeld));assert.ok(!("refreshToken" in googleHeld));
  }finally{await prisma.$disconnect();}
});
