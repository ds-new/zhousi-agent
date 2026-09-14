import assert from 'node:assert/strict';
import {it} from 'node:test';
import {once} from 'node:events';
import {MemoryStore} from '@diy-agent/db';
import {createControlPlaneServer} from '../src/server.js';

it('resolves authorized session execution data in one store operation and rejects another session token',async()=>{
 const store=new MemoryStore();const tenant=await store.createTenant({name:'bootstrap'});
 const ws=(await store.createWorkspace({tenantId:tenant.id}))!;
 const {profile,version}=(await store.createProfile({tenantId:tenant.id,workspaceId:ws.id,profile:{}}))!;
 await store.pinProfile(profile.id,version.id);
 const session=(await store.createSession({tenantId:tenant.id,profileId:profile.id}))!;
 const other=(await store.createSession({tenantId:tenant.id,profileId:profile.id}))!;
 const calls:string[]=[];const observed=new Proxy(store,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?(...args:unknown[])=>{calls.push(String(key));return value.apply(target,args);}:value;}});
 const cp=createControlPlaneServer({store:observed,authMode:'api_key'});await once(cp.server,'listening');
 try{
  const resolve=(token:string)=>fetch(cp.baseUrl+'/sessions/resolve',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({sessionId:session.session.id,checkQuota:true})});
  const response=await resolve(session.sessionToken);assert.equal(response.status,200);const data=await response.json();
  assert.equal(data.session.profileVersionId,version.id);assert.equal(data.snapshot.id,profile.id);assert.equal(data.tenantId,tenant.id);
  assert.deepEqual(calls,['resolveSessionBootstrap']);
  calls.length=0;assert.equal((await resolve(other.sessionToken)).status,401);assert.deepEqual(calls,['resolveSessionBootstrap']);
 }finally{await cp.close();}
});
