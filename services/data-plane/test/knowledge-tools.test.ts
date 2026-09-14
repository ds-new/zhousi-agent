import assert from 'node:assert/strict';
import {it} from 'node:test';
import {AgentRuntime} from '../src/agent-runtime.js';
const snapshot={id:'p',workspaceId:'w',systemPrompt:'Answer',name:'p',governanceTier:'L1',skillIds:[],mcpBindings:[],modelRoute:{provider:'custom',model:'test',baseUrl:'http://model.local'},kbConfig:{internal:{enabled:true},retrievalMode:'tool'}};
const input={tenantId:'t',workspaceId:'w',sessionId:'s',requestId:'r',profileVersionId:'v',input:'question',snapshot};
it('tool mode exposes kb_search and performs no retrieval when the model answers directly',async()=>{
 let searches=0;let names:string[]=[];
 const runtime=new AgentRuntime({retrieve:async()=>{searches++;return 'evidence';},allowedModelOrigins:['http://model.local'],fetchImpl:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));names=(body.tools??[]).map((tool:any)=>tool.function.name);return Response.json({choices:[{message:{role:'assistant',content:'answer'}}]});
 }});
 try{await runtime.run(input as never);assert.equal(searches,0);assert.ok(names.includes('kb_search'));}finally{await runtime.close();}
});
it('selected knowledge tool uses the model query and sends evidence back before final answer',async()=>{
 let query='';let count=0;
 const runtime=new AgentRuntime({retrieve:async args=>{query=args.input;return 'specific evidence';},allowedModelOrigins:['http://model.local'],fetchImpl:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));count++;
  if(count===1)return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'kb1',type:'function',function:{name:'kb_search',arguments:'{"query":"precise question"}'}}]}}]});
  assert.equal(body.messages.at(-1).role,'tool');assert.match(body.messages.at(-1).content,/specific evidence/);
  return Response.json({choices:[{message:{role:'assistant',content:'answer'}}]});
 }});
 try{const result=await runtime.run(input as never);assert.equal(query,'precise question');assert.deepEqual(result.toolCalls,[{name:'kb_search',ok:true}]);}finally{await runtime.close();}
});
it('auto mode retrieves once and does not register the knowledge tool',async()=>{
 let searches=0;
 const runtime=new AgentRuntime({retrieve:async()=>{searches++;return 'auto evidence';},allowedModelOrigins:['http://model.local'],fetchImpl:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));assert.match(body.messages.at(-1).content,/auto evidence/);assert.equal(body.tools,undefined);
  return Response.json({choices:[{message:{role:'assistant',content:'answer'}}]});
 }});
 try{await runtime.run({...input,snapshot:{...snapshot,kbConfig:{...snapshot.kbConfig,retrievalMode:'auto'}}} as never);assert.equal(searches,1);}finally{await runtime.close();}
});

it('knowledge tools use the existing approval checkpoint and do not mutate the fixed snapshot',async()=>{
 let searches=0;let calls=0;
 const external={serverName:'kb',transport:'http',url:'https://kb.example/mcp'};
 const scoped={...input,snapshot:{...snapshot,kbConfig:{...snapshot.kbConfig,externalMcp:external}},mcpCatalog:[{...external,tenantId:'t',approvalStatus:'approved',defaultSensitivity:'readonly'}],policy:{rules:[{toolPattern:'kb_search',effect:'ask'}]}};
 const before=structuredClone(scoped.snapshot);
 const runtime=new AgentRuntime({retrieve:async()=>{searches++;return 'approved evidence';},allowedModelOrigins:['http://model.local'],fetchImpl:async()=>{
  calls++;return Response.json({choices:[{message:calls===1?{role:'assistant',content:null,tool_calls:[{id:'kb1',type:'function',function:{name:'kb_search',arguments:'{"query":"precise question"}'}}]}:{role:'assistant',content:'answer'}}]});
 }});
 try{
  const pending=await runtime.run(scoped as never);assert.equal(pending.status,'requires_approval');assert.equal(searches,0);
  await runtime.approve({...input,approvalId:pending.approvalId!,decision:'allow'});
  const result=await runtime.run(scoped as never);assert.equal(result.output,'answer');assert.equal(searches,1);assert.deepEqual(scoped.snapshot,before);
  await runtime.run(scoped as never);assert.equal(searches,1);
 }finally{await runtime.close();}
});

it('denied auto knowledge access does not call retrieval or model',async()=>{
 let calls=0;const runtime=new AgentRuntime({strictPolicy:true,retrieve:async()=>{calls++;return '';},fetchImpl:async()=>{calls++;throw new Error('unexpected_model');}});
 try{await assert.rejects(runtime.run({...input,snapshot:{...snapshot,kbConfig:{...snapshot.kbConfig,retrievalMode:'auto'}}} as never),/policy_denied/);assert.equal(calls,0);}finally{await runtime.close();}
});
