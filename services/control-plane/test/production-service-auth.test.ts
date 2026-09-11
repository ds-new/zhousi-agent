import assert from 'node:assert/strict';
import {it} from 'node:test';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {MemoryStore} from '@diy-agent/db';
import {createControlPlaneServer} from '../src/server.js';
it('records verified administrator identity for approvals and blocks workspace builders',async()=>{
 const store=new MemoryStore();const tenant=await store.createTenant({name:'approval'});
 const ws=(await store.createWorkspace({tenantId:tenant.id}))!;const {profile}=(await store.createProfile({tenantId:tenant.id,workspaceId:ws.id,profile:{}}))!;
 await store.addWorkspaceMember(ws.id,'builder','builder');const key=await store.createApiKey(tenant.id,'admin');
 let forwarded:Record<string,unknown>|undefined;
 const dp=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;forwarded=JSON.parse(body);res.setHeader('Content-Type','application/json');res.end('{}');});
 dp.listen(0,'127.0.0.1');await once(dp,'listening');
 const cp=createControlPlaneServer({store,authMode:'api_key',allowDevOidc:true,dataPlaneUrl:`http://127.0.0.1:${(dp.address() as {port:number}).port}`,dataPlaneInternalToken:'trusted'});
 await once(cp.server,'listening');
 try{
   const body={tenantId:tenant.id,workspaceId:ws.id,profileId:profile.id,sessionId:'s',requestId:'r',decision:'allow',reviewer:'spoofed'};
   for(const [token,status] of [[`oidc.${tenant.id}.builder`,403],[key.key,200]] as const){
     const response=await fetch(cp.baseUrl+'/tool-approvals/approval-1',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
     assert.equal(response.status,status);
   }
   assert.equal(forwarded?.reviewer,`api_key:${key.record.id}`);
   const audit=(await store.listAuditLog(tenant.id)).find(event=>event.action==='tool.approval_decided');
   assert.equal(audit?.actor,`api_key:${key.record.id}`);
 }finally{await cp.close();await new Promise<void>(resolve=>dp.close(()=>resolve()));}
});
it('tenant service tokens cannot read another tenant or submit cross-tenant usage; replay is charged once',async()=>{
 const store=new MemoryStore();const a=await store.createTenant({name:'A'});const b=await store.createTenant({name:'B'});
 const ws=(await store.createWorkspace({tenantId:a.id}))!;const {profile,version}=(await store.createProfile({tenantId:a.id,workspaceId:ws.id,profile:{}}))!;
 const cp=createControlPlaneServer({store,authMode:'api_key',serviceAccountMode:'token',serviceAccountTenantTokens:{[a.id]:'diy_sa_service-a'}} as never);
 await once(cp.server,'listening');
 const post=(body:unknown)=>fetch(cp.baseUrl+'/usage/events',{method:'POST',headers:{Authorization:'Bearer diy_sa_service-a','Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
 assert.equal((await fetch(cp.baseUrl+`/tenants/${b.id}/profile-sync`,{headers:{Authorization:'Bearer diy_sa_service-a'}})).status,403);
 const usage={eventId:'stable-event',tenantId:a.id,profileId:profile.id,profileVersionId:version.id,tokensUsed:10};
 assert.equal((await post({...usage,tenantId:b.id})).status,403);
 assert.equal((await post({...usage,tokensUsed:-10})).status,400);
 const first=await post(usage);assert.equal(first.status,201);assert.equal((await first.json()).duplicate,false);
 const second=await post(usage);assert.equal(second.status,200);assert.equal((await second.json()).duplicate,true);
 assert.equal((await post({...usage,tokensUsed:11})).status,409);
 assert.equal((await store.checkSessionQuota(a.id)).tokensUsedToday,10);
 }finally{await cp.close();}
});
