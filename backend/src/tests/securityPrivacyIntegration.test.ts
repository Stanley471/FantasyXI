import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { prisma } from "../config/db.js";
import { signAccessToken } from "../config/jwt.js";
import { Permission } from "../config/permissions.js";
import { requireAuth, requirePermission } from "../middleware/authMiddleware.js";
import { authRateLimiter } from "../middleware/rateLimiter.js";
import { loginSecurityService } from "../services/security/loginSecurityService.js";
import { PrivacyService } from "../services/privacy/privacyService.js";
import { FinancialMerkleService } from "../services/audit/financialMerkleService.js";

const url = process.env.FANTASY_TEST_DATABASE_URL;
test("combined erasure removes verified login history while preserving verifiable financial evidence and denying old authority", {skip:!url}, async () => {
  const location = new URL(url!);
  assert.equal(location.hostname,"127.0.0.1");assert.equal(location.pathname,"/fantasy_combined");
  assert.equal(process.env.DATABASE_URL,url);
  const id=randomUUID(), email=`${id}@example.test`;
  const privacy=new PrivacyService(prisma,{
    put:async()=>{throw new Error("Erasure must not upload");},
    link:async()=>{throw new Error("Erasure must not sign download links");},
    delete:async()=>{},
  });
  const audit=new FinancialMerkleService(prisma,{
    list:async()=>[],read:async()=>{throw new Error("No independently published test roots");},
    publish:async()=>{throw new Error("No live publication in integration tests");},
  },async()=>{throw new Error("Unexpected financial integrity alert");});
  try {
    await prisma.user.create({data:{id,email,username:id,name:"Synthetic integration account"}});
    const transaction=await prisma.transaction.create({data:{userId:id,type:"ENTRY_FEE",amount:"12.50",status:"CONFIRMED"}});
    await loginSecurityService.acceptVerifiedLogin({userId:id,email,username:id,ip:"198.51.100.8",userAgent:"Synthetic Chrome desktop",location:{latitude:51.5,longitude:0}});
    assert.equal(await prisma.loginTrustedLocation.count({where:{userId:id}}),1);
    const before=await audit.verify();assert.ok(before.some(row=>row.transaction_id===transaction.id));
    const app=express();
    app.get("/admin",authRateLimiter,requireAuth,requirePermission(Permission.PAYOUT_MANAGE),(_req,res)=>{res.json({private:"financial data"});});
    // A still-valid ADMIN claim cannot override the account's current USER role.
    const staleAdmin=signAccessToken({userId:id,email,username:id,role:"ADMIN"});
    assert.equal((await request(app).get("/admin").auth(staleAdmin,{type:"bearer"})).status,403);
    const job=await privacy.request(id,"ERASE");await privacy.runNext();
    assert.equal((await privacy.status(id,job.id))?.status,"DONE");
    assert.equal(await prisma.loginSecurityActivity.count({where:{userId:id}}),0);
    assert.equal(await prisma.loginTrustedLocation.count({where:{userId:id}}),0);
    assert.ok(await prisma.transaction.findUnique({where:{id:transaction.id}}));
    const after=await audit.verify();assert.deepEqual(after.filter(row=>row.transaction_id===transaction.id).map(row=>row.hash),before.filter(row=>row.transaction_id===transaction.id).map(row=>row.hash));
    const denied=await request(app).get("/admin").auth(staleAdmin,{type:"bearer"});
    assert.equal(denied.status,401);assert.equal(denied.body.private,undefined);
  } finally { await prisma.$disconnect(); }
});
