import assert from 'node:assert/strict';
import {it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {AgentRuntime} from '../src/agent-runtime.js';
import {MemoryArtifacts} from '../src/artifact-store.js';

const binding={serverName:'echo',transport:'stdio',command:process.execPath,args:[fileURLToPath(new URL('../../../packages/dsh-mcp-pool-plugin/test/fixtures/mcp-server.mjs',import.meta.url))]};
const input={tenantId:'a',workspaceId:'w',sessionId:'s',requestId:'r',profileVersionId:'v',input:'call tool',
  snapshot:{id:'p',workspaceId:'w',systemPrompt:'tool test',modelRoute:{provider:'custom',model:'tiny',baseUrl:'http://model.local/v1'},skillIds:[],mcpBindings:[binding],governanceTier:'L1',name:'test'},
  mcpCatalog:[{...binding,tenantId:'a',approvalStatus:'approved'}],policy:{rules:[{toolPattern:'*',effect:'ask'}]}};
function fixture(){let modelCalls=0;const files=new MemoryArtifacts();const runtime=new AgentRuntime({files,allowedModelOrigins:['http://model.local'],fetchImpl:async()=>{
 modelCalls++;return Response.json({usage:{total_tokens:7},choices:[{message:modelCalls===1?{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'tool_0',arguments:'{"message":"evidence"}'}}]}:{role:'assistant',content:'completed'}}]});
}});return {runtime,files,calls:()=>modelCalls};}

it('persists a pending approval, resumes exactly once, and replays the result',async()=>{
 const {runtime,calls}=fixture();try{
  const pending=await runtime.run(input as never);assert.equal(pending.status,'requires_approval');assert.equal(pending.toolCalls.length,0);
  const repeated=await runtime.run(input as never);assert.equal(repeated.approvalId,pending.approvalId);assert.equal(calls(),1);
  await runtime.approve({...input,approvalId:pending.approvalId!,decision:'allow'});
  const done=await runtime.run(input as never);assert.equal(done.output,'completed');assert.equal(done.tokensUsed,14);assert.equal(done.toolCalls.length,1);
  assert.deepEqual(await runtime.run(input as never),done);assert.equal(calls(),2);
  await assert.rejects(runtime.approve({...input,approvalId:pending.approvalId!,decision:'allow'}),/approval_not_pending/);
 }finally{await runtime.close();}
});
it('rejects another tenant and expired approval without executing the tool',async()=>{
 const {runtime,files,calls}=fixture();try{
  const pending=await runtime.run(input as never);
  await assert.rejects(runtime.approve({...input,tenantId:'b',approvalId:pending.approvalId!,decision:'allow'}),/approval_not_found/);
  const scope=['a','w','s','r',pending.approvalId!];
  const record=await files.read<Record<string,unknown>>('approvals',scope);await files.write('approvals',scope,{...record,expiresAt:new Date(0)});
  await assert.rejects(runtime.approve({...input,approvalId:pending.approvalId!,decision:'allow'}),/approval_expired/);
  assert.equal(calls(),1);
 }finally{await runtime.close();}
});
it('requires the exact interrupted request before unlocking the session',async()=>{
 const files=new MemoryArtifacts();await files.write('execution',['a','w','s'],{status:'running',requestId:'lost'});
 await files.write('turns',['a','w','s','lost'],{status:'running',fingerprint:'old'});
 const runtime=new AgentRuntime({files});try{
  await assert.rejects(runtime.recoverSession({tenantId:'a',workspaceId:'w',sessionId:'s',expectedRequestId:'different'}),/execution_request_mismatch/);
  await runtime.recoverSession({tenantId:'a',workspaceId:'w',sessionId:'s',expectedRequestId:'lost'});
  assert.equal((await files.read<{status:string}>('execution',['a','w','s']))?.status,'recovered');
  assert.equal((await files.read<{status:string}>('turns',['a','w','s','lost']))?.status,'abandoned');
 }finally{await runtime.close();}
});

import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
it('does not replay tools executed before an approval pause, including across runtime restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'diy-approval-'));const log=join(directory,'calls');
 const script=fileURLToPath(new URL('./fixtures/approval-mcp.mjs',import.meta.url));
 const bindings=['auto','review'].map(serverName=>({...binding,serverName,args:[script,log]}));
 const scoped={...input,snapshot:{...input.snapshot,mcpBindings:bindings},mcpCatalog:bindings.map(b=>({...b,tenantId:'a',approvalStatus:'approved'})),
   policy:{rules:[{toolPattern:'mcp__auto__*',effect:'allow'},{toolPattern:'mcp__review__*',effect:'ask'}]}};
 const files=new MemoryArtifacts();let calls=0;const options={files,allowedModelOrigins:['http://model.local'],fetchImpl:async()=>{
   calls++;return Response.json({usage:{total_tokens:3},choices:[{message:calls===1?{role:'assistant',content:null,tool_calls:[
    {id:'first',type:'function',function:{name:'tool_0',arguments:'{"message":"first"}'}},
    {id:'second',type:'function',function:{name:'tool_1',arguments:'{"message":"second"}'}}
   ]}:{role:'assistant',content:'done'}}]});
 }};
 let runtime=new AgentRuntime(options);try{
   const pending=await runtime.run(scoped as never);assert.equal(pending.toolCalls.length,1);assert.equal(await readFile(log,'utf8'),'first\n');
   await runtime.close();runtime=new AgentRuntime(options);
   await runtime.approve({...input,approvalId:pending.approvalId!,decision:'allow'});
   const done=await runtime.run(scoped as never);assert.equal(done.toolCalls.length,2);assert.equal(await readFile(log,'utf8'),'first\nsecond\n');
   await runtime.run(scoped as never);assert.equal(await readFile(log,'utf8'),'first\nsecond\n');
   const events=await files.list<{tokensUsed:number}>('outbox','a');assert.equal(events.reduce((sum,event)=>sum+event.value.tokensUsed,0),6);
 }finally{await runtime.close();await rm(directory,{recursive:true,force:true});}
});
it('denial immediately ends the request and permits a later session request',async()=>{
 const {runtime,calls}=fixture();try{
  const pending=await runtime.run(input as never);
  await assert.rejects(runtime.run({...input,requestId:'next'} as never),/execution_outcome_unknown/);
  await runtime.approve({...input,approvalId:pending.approvalId!,decision:'deny'});
  assert.equal((await runtime.run(input as never)).status,'denied');assert.equal(calls(),1);
  assert.equal((await runtime.run({...input,requestId:'next'} as never)).output,'completed');
 }finally{await runtime.close();}
});
it('a resumed approval retains the original total model round limit',async()=>{
 let calls=0;const runtime=new AgentRuntime({maxTurns:1,allowedModelOrigins:['http://model.local'],fetchImpl:async()=>{
  calls++;return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'c',type:'function',function:{name:'tool_0',arguments:'{"message":"one"}'}}]}}]});
 }});try{
  const pending=await runtime.run(input as never);await runtime.approve({...input,approvalId:pending.approvalId!,decision:'allow'});
  await assert.rejects(runtime.run(input as never),/agent_turn_limit/);assert.equal(calls,1);
  await assert.rejects(runtime.run(input as never),/execution_outcome_unknown/);
 }finally{await runtime.close();}
});
it('rejects changed authoritative MCP bindings on resume',async()=>{
 const {runtime}=fixture();try{
  const pending=await runtime.run(input as never);await runtime.approve({...input,approvalId:pending.approvalId!,decision:'allow'});
  await assert.rejects(runtime.run({...input,mcpCatalog:[{...input.mcpCatalog[0],args:[...binding.args,'changed-binding']}]} as never),/approval_binding_changed/);
 }finally{await runtime.close();}
});
