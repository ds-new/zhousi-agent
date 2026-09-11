import assert from 'node:assert/strict';import {it} from 'node:test';import {once} from 'node:events';
import {createDataPlaneServer} from '../src/server.js';import {MemoryArtifacts} from '../src/artifact-store.js';
it('fixed-tenant internal routes cannot validate an envelope and then execute another tenant body',async()=>{
 const files=new MemoryArtifacts();const dp=createDataPlaneServer({tenantId:'tenant-a',internalToken:'service',files});await once(dp.server,'listening');
 try{
 for(const [method,path] of [['PUT','/skills/content'],['POST','/kb/documents'],['POST','/kb/search']]){
 const response=await fetch(dp.baseUrl+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer service'},body:JSON.stringify({tenantId:'tenant-b',payload:{tenantId:'tenant-a'},content:'do not write',workspaceId:'w',query:'secret',kbConfig:{internal:{enabled:true}}})});
 assert.equal(response.status,403,`${method} ${path}`);
 }
 assert.equal((await files.list('skills','tenant-b')).length,0);
 const invalid=await fetch(dp.baseUrl+'/agent/run',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer service'},body:'null'});assert.equal(invalid.status,400);
 }finally{await dp.close();}
});
