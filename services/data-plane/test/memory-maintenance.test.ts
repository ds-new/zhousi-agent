import assert from 'node:assert/strict';
import {it} from 'node:test';
import {MemoryArtifacts} from '../src/artifact-store.js';
import {maintainMemory} from '../src/memory-maintenance.js';
it('retires expired memory without a user turn, preserves unexpired facts, and never sweeps another tenant',async()=>{
 const files=new MemoryArtifacts();const active={id:'active',workspaceId:'w',kind:'fact',content:'Keep',createdAt:new Date(),updatedAt:new Date()};
 const expired={...active,id:'expired',content:'Old',ttl:new Date(Date.now()-1000)};
 await files.write('workspace-memory',['a','w'],{entries:[active,expired],archive:[]});await files.write('workspace-memory',['b','w'],{entries:[expired],archive:[]});
 assert.equal(await maintainMemory(files,'a'),1);
 const result=await files.read<any>('workspace-memory',['a','w']);assert.deepEqual(result.entries.map((e:any)=>e.id),['active']);
 assert.equal((await files.read<any[]>('workspace-memory-archive',['a','w']))![0].id,'expired');
 assert.equal((await files.read<any>('workspace-memory',['b','w'])).entries.length,1);
});
