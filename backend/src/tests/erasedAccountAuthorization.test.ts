import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { signAccessToken } from "../config/jwt.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { authRateLimiter } from "../middleware/rateLimiter.js";
import { setAccountStatusResolver } from "../services/privacy/accountStatus.js";

test("previously issued valid tokens cannot access protected data after erasure",async()=>{
  let erased=false;setAccountStatusResolver(()=>erased);
  try{
    const token=signAccessToken({userId:"synthetic-user",email:"user@example.test",username:"synthetic",role:"USER"});
    const app=express();app.get("/protected",authRateLimiter,requireAuth,(_req,res)=>{res.json({private:"data"});});
    assert.equal((await request(app).get("/protected").auth(token,{type:"bearer"})).status,200);
    erased=true;
    const response=await request(app).get("/protected").auth(token,{type:"bearer"});
    assert.equal(response.status,401);assert.equal(response.body.private,undefined);
  }finally{setAccountStatusResolver(null);}
});
