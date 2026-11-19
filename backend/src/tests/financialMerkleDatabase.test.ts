import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { FinancialMerkleService, type PublicRoot } from "../services/audit/financialMerkleService.js";
import { verifyFinancialProof } from "../services/audit/financialMerkle.js";

const url=process.env.FANTASY_TEST_DATABASE_URL;
test("PostgreSQL financial capture, proof publication/retry and out-of-band tamper detection",{skip:!url},async()=>{
  const parsed=new URL(url!);assert.equal(parsed.hostname,"127.0.0.1");assert.match(parsed.pathname,/^\/fantasy_(?:451(?:_v\d+)?|combined)$/);
  const client=new pg.Client({connectionString:url,connectionTimeoutMillis:3000});await client.connect();
  let failInsert=false,alerts=0;const published=new Map<string,PublicRoot>();
  const sql=(parts:TemplateStringsArray,values:unknown[])=>parts.reduce((all,part,index)=>all+(index?`$${index}`:"")+part,"");
  const db={
    $transaction:async(handler:(database:unknown)=>Promise<unknown>)=>handler(db),
    $queryRaw:async(parts:TemplateStringsArray,...values:unknown[])=>{
      const result=await client.query(sql(parts,values),values);
      return result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,["sequence","first_sequence","last_sequence","count"].includes(key)?BigInt(value as string):value])));
    },
    $executeRaw:async(parts:TemplateStringsArray,...values:unknown[])=>{
      if(failInsert && parts.join("").includes("INSERT INTO financial_merkle_roots")){failInsert=false;throw new Error("simulated crash after independent publication");}
      return (await client.query(sql(parts,values),values)).rowCount;
    },
  };
  const service=new FinancialMerkleService(db as never,{
    list:async()=>[...published.values()],read:async hour=>{if(!published.has(hour))throw new Error("missing root");return published.get(hour)!;},
    publish:async root=>{published.set(root.hour,structuredClone(root));return `https://audit.example.test/${root.hour}`;},
  },async()=>{alerts++;return {slack:"skipped",email:{sent:0,failed:0}};});
  await client.query("BEGIN");
  try{
    const user=randomUUID(),transaction=randomUUID();
    await client.query("INSERT INTO users(id,email,username,updated_at) VALUES($1,$2,$3,now())",[user,`${user}@example.test`,user]);
    await client.query("INSERT INTO transactions(id,user_id,type,amount,status) VALUES($1,$2,'ENTRY_FEE',12.50,'CONFIRMED')",[transaction,user]);
    const entries=await service.verify();assert.ok(entries.some(entry=>entry.transaction_id===transaction));
    failInsert=true;
    await assert.rejects(()=>service.publishClosedHours(new Date(Date.now()+7_200_000)),/simulated crash/);
    await service.publishClosedHours(new Date(Date.now()+7_200_000));
    const proofs=await service.proof(transaction);assert.ok(proofs.length);
    assert.equal(verifyFinancialProof(proofs[0].hash,proofs[0].proof,proofs[0].publication.root),true);
    await client.query("SAVEPOINT forbidden_edit");
    await assert.rejects(()=>client.query("UPDATE financial_audit_logs SET amount=999 WHERE transaction_id=$1",[transaction]),/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT forbidden_edit");
    await client.query("SAVEPOINT tamper");
    await client.query("ALTER TABLE financial_audit_logs DISABLE TRIGGER USER");
    await client.query("UPDATE financial_audit_logs SET amount=999 WHERE transaction_id=$1",[transaction]);
    await assert.rejects(()=>service.verify(),/integrity verification failed/);assert.equal(alerts,1);
    await client.query("ROLLBACK TO SAVEPOINT tamper");
    await client.query("SAVEPOINT transaction_tamper");
    await client.query("ALTER TABLE transactions DISABLE TRIGGER USER");
    await client.query("UPDATE transactions SET amount=999 WHERE id=$1",[transaction]);
    await assert.rejects(()=>service.verify(),/integrity verification failed/);assert.equal(alerts,2);
    await client.query("ROLLBACK TO SAVEPOINT transaction_tamper");
    await client.query("SAVEPOINT transaction_delete");
    await client.query("ALTER TABLE transactions DISABLE TRIGGER USER");
    await client.query("DELETE FROM transactions WHERE id=$1",[transaction]);
    await assert.rejects(()=>service.verify(),/integrity verification failed/);assert.equal(alerts,3);
    await client.query("ROLLBACK TO SAVEPOINT transaction_delete");
    await client.query("ALTER TABLE financial_merkle_entries DISABLE TRIGGER USER");
    await client.query("DELETE FROM financial_merkle_entries WHERE sequence=(SELECT max(sequence) FROM financial_merkle_entries)");
    await assert.rejects(()=>service.verify(),/integrity verification failed/);assert.equal(alerts,4);
  }finally{await client.query("ROLLBACK");await client.end();}
});
