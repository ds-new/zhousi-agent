import assert from 'node:assert/strict';
import {it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentRuntime} from '../src/agent-runtime.js';
import {PostgresArtifacts} from '../src/postgres-artifacts.js';

it('persists approvals across PostgreSQL replicas and consumes a real MCP action once',async()=>{
 assert.ok(process.env.DIY_TEST_DATABASE_URL);
 const directory=await mkdtemp(join(tmpdir(),'approval-pg-'));const log=join(directory,'calls');
 const filesA=new PostgresArtifacts(process.env.DIY_TEST_DATABASE_URL);const filesB=new PostgresArtifacts(process.env.DIY_TEST_DATABASE_URL);
 await filesA.init();await filesB.init();const tenantId=crypto.randomUUID();let calls=0;
 const fetchImpl:typeof fetch=async()=>{calls++;return Response.json({usage:{total_tokens:5},choices:[{message:calls===1?
  {role:'assistant',content:null,tool_calls:[{id:'c',type:'function',function:{name:'tool_0',arguments:'{"message":"once"}'}}]}:{role:'assistant',content:'done'}}]});};
 const first=new AgentRuntime({files:filesA,allowedModelOrigins:['http://model.local'],fetchImpl});
 const second=new AgentRuntime({files:filesB,allowedModelOrigins:['http://model.local'],fetchImpl});
 const binding={serverName:'echo',transport:'stdio',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/approval-mcp.mjs',import.meta.url)),log]};
 const input={tenantId,workspaceId:'w',sessionId:'s',requestId:'r',profileVersionId:'v',input:'action',snapshot:{id:'p',workspaceId:'w',systemPrompt:'test',modelRoute:{provider:'custom',model:'tiny',baseUrl:'http://model.local'},skillIds:[],mcpBindings:[binding],governanceTier:'L1',name:'test'},mcpCatalog:[{...binding,tenantId,approvalStatus:'approved'}],policy:{rules:[{toolPattern:'*',effect:'ask'}]}};
 try{
  const pending=await first.run(input as never);assert.equal(pending.status,'requires_approval');await first.close();
  assert.equal((await second.run(input as never)).approvalId,pending.approvalId);
  const decision={...input,approvalId:pending.approvalId!,decision:'allow' as const};
  const raced=await Promise.allSettled([second.approve(decision),second.approve(decision)]);
  assert.equal(raced.filter(result=>result.status==='fulfilled').length,1);
  const result=await second.run(input as never);assert.equal(result.output,'done');
  assert.deepEqual(await second.run(input as never),result);assert.equal(await readFile(log,'utf8'),'once\n');assert.equal(calls,2);
  assert.equal((await filesB.list<{tokensUsed:number}>('outbox',tenantId)).reduce((sum,event)=>sum+event.value.tokensUsed,0),10);
 }finally{await first.close();await second.close();await filesA.close();await filesB.close();await rm(directory,{recursive:true,force:true});}
});

import pg from 'pg';
it('lost session locks prevent further tools and block both old and new requests until explicit recovery',async()=>{
 assert.ok(process.env.DIY_TEST_DATABASE_URL);const url=new URL(process.env.DIY_TEST_DATABASE_URL);const label='approval-lock-'+crypto.randomUUID();url.searchParams.set('application_name',label);
 const files=new PostgresArtifacts(url.toString());await files.init();const admin=new pg.Pool({connectionString:process.env.DIY_TEST_DATABASE_URL});
 let calls=0;const tenantId=crypto.randomUUID();const runtime=new AgentRuntime({files,allowedModelOrigins:['http://model.local'],fetchImpl:async(_url,init)=>{
  calls++;
  if(calls===1){
   await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'",[label]);
   await new Promise<void>(resolve=>{if(init?.signal?.aborted)resolve();else init?.signal?.addEventListener('abort',()=>resolve(),{once:true});});
  }
  return Response.json({choices:[{message:{role:'assistant',content:'done'}}]});
 }});
 const input={tenantId,workspaceId:'w',sessionId:'s',requestId:'uncertain',profileVersionId:'v',input:'action',snapshot:{id:'p',workspaceId:'w',systemPrompt:'test',modelRoute:{provider:'custom',model:'tiny',baseUrl:'http://model.local'},skillIds:[],mcpBindings:[],governanceTier:'L1',name:'test'}};
 try{
  await assert.rejects(runtime.run(input as never));
  await assert.rejects(runtime.run({...input,requestId:'another'} as never),/execution_outcome_unknown/);assert.equal(calls,1);
  await runtime.recoverSession({...input,expectedRequestId:'uncertain'});
  await assert.rejects(runtime.run(input as never),/execution_outcome_unknown/);
  assert.equal((await runtime.run({...input,requestId:'after-recovery'} as never)).output,'done');assert.equal(calls,2);
 }finally{await runtime.close();await files.close();await admin.end();}
});
