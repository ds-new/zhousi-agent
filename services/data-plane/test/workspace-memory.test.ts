import assert from 'node:assert/strict';
import {it} from 'node:test';
import {AgentRuntime} from '../src/agent-runtime.js';
import {MemoryArtifacts} from '../src/artifact-store.js';
import {governMemory} from '@diy-agent/dsh-memory-plugin';
import {WorkspaceMemory,maintainWorkspaceMemories} from '../src/workspace-memory.js';

it('the model sees the latest twenty workspace memories, independent of persisted order',async()=>{
 const files=new MemoryArtifacts();const now=Date.now();
 const entries=Array.from({length:25},(_,i)=>({id:String(i),workspaceId:'w',kind:'fact' as const,content:`memory[${i}]`,createdAt:new Date(now-30000),updatedAt:new Date(now-25000+i*1000)}));
 const governed=governMemory('w',{workspaceId:'w' as never,maxEntries:1000,dedupSimilarityThreshold:0.92,compactionTriggerCount:50},entries as never);
 await files.write('workspace-memory',['t','w'],{entries:governed.entries,archive:[]});
 let system='';const runtime=new AgentRuntime({files,allowedModelOrigins:['http://model.local'],fetchImpl:async(_url,init)=>{
  system=JSON.parse(String(init?.body)).messages[0].content;
  return Response.json({choices:[{message:{role:'assistant',content:'answer'}}]});
 }});
 try{
  await runtime.run({tenantId:'t',workspaceId:'w',sessionId:'s',profileVersionId:'v',input:'question',snapshot:{id:'p',workspaceId:'w',systemPrompt:'system',skillIds:[],mcpBindings:[],modelRoute:{provider:'custom',model:'test',baseUrl:'http://model.local'},name:'p',governanceTier:'L1'}} as never);
  assert.ok(system.includes('memory[24]'));assert.ok(system.includes('memory[5]'));assert.ok(!system.includes('memory[0]'));
  assert.ok(system.indexOf('memory[24]')<system.indexOf('memory[5]'));
 }finally{await runtime.close();}
});

it('migrates mixed memory once, keeps archive off the hot path, and skips unchanged maintenance writes',async()=>{
 class Observed extends MemoryArtifacts {
  coldReads=0;writes=0;
  override async read<T>(kind:string,scope:string[]){if(kind==='workspace-memory-archive')this.coldReads++;return super.read<T>(kind,scope);}
  override async write(kind:string,scope:string[],value:unknown,expiresAt?:Date){this.writes++;return super.write(kind,scope,value,expiresAt);}
 }
 const files=new Observed();const memory=new WorkspaceMemory(files);const now=new Date();
 const fact={id:'fact',workspaceId:'w',kind:'fact' as const,content:'recent fact',createdAt:now,updatedAt:now};
 const archive=Array.from({length:1000},(_,i)=>({...fact,id:`old${i}`,content:'x'.repeat(3900),archivedAt:now,expiresAt:new Date(Date.now()+86400000)}));
 await files.write('workspace-memory',['t','w'],{entries:[fact],archive});
 await memory.maintain('t','w');
 assert.equal((await files.read<any>('workspace-memory',['t','w'])).archive,undefined);
 assert.equal((await files.read<any[]>('workspace-memory-archive',['t','w']))!.length,1000);
 files.coldReads=0;files.writes=0;
 assert.equal(await memory.context('t','w'),'recent fact');
 await memory.append('t','w',{...fact,id:'new',content:'a new fact'} as never);
 assert.equal(files.coldReads,0,'normal context and append must not load cold payload');
 files.writes=0;await memory.maintain('t','w');assert.equal(files.writes,0,'stable active/archive must not be rewritten');
});

it('merges mixed-layout archives without duplicates and discovers legacy-only workspaces',async()=>{
 const files=new MemoryArtifacts();const now=new Date();
 const fact={id:'a',workspaceId:'w',kind:'fact',content:'a',createdAt:now,updatedAt:now,archivedAt:now,expiresAt:new Date(Date.now()+86400000)};
 await files.write('workspace-memory',['t','w'],{entries:[],archive:[fact]});
 await files.write('workspace-memory-archive',['t','w'],[{...fact,id:'b',content:'b'},{...fact,id:'b',content:'b'}]);
 await new WorkspaceMemory(files).maintain('t','w');
 assert.deepEqual((await files.read<any[]>('workspace-memory-archive',['t','w']))!.map(e=>e.id).sort(),['a','b']);
 await files.write('memory',['t','legacy'],[{...fact,workspaceId:'legacy',ttl:new Date(0)}]);
 await files.write('memory-archive',['t','legacy'],[{...fact,id:'old',workspaceId:'legacy',expiresAt:new Date(0)}]);
 await maintainWorkspaceMemories(files,'t');
 assert.equal(await files.read('memory',['t','legacy']),undefined);assert.equal(await files.read('memory-archive',['t','legacy']),undefined);
 assert.equal((await files.read<any>('workspace-memory',['t','legacy'])).entries.length,0);
 assert.equal((await files.read<any[]>('workspace-memory-archive',['t','legacy']))!.length,1);
});

it('the latest fact survives context truncation after episodic compaction',async()=>{
 const files=new MemoryArtifacts();const memory=new WorkspaceMemory(files);const now=new Date();
 const entries=Array.from({length:50},(_,i)=>({id:String(i),workspaceId:'w',kind:'episodic',content:`old-${i} `+'x'.repeat(500),createdAt:now,updatedAt:now}));
 await files.write('workspace-memory',['t','w'],{format:2,entries});
 await memory.append('t','w',{...entries[0],id:'new',content:'NEWEST_FACT'} as never);
 assert.match(await memory.context('t','w'),/NEWEST_FACT/);
});

it('archive limits include metadata and JSON framing so small facts cannot overflow artifact storage',async()=>{
 const files=new MemoryArtifacts();const now=new Date();
 const fact={id:'new',workspaceId:'w',kind:'fact',content:'x',createdAt:now,updatedAt:now,ttl:new Date(0)};
 const archive=Array.from({length:18000},(_,i)=>({...fact,id:String(i).padStart(128,'x'),sourceSessionId:'s'.repeat(128),archivedAt:now,expiresAt:new Date(Date.now()+86400000)}));
 await files.write('workspace-memory',['t','w'],{format:2,entries:[fact]});await files.write('workspace-memory-archive',['t','w'],archive);
 await new WorkspaceMemory(files).maintain('t','w');
 const retained=await files.read<any[]>('workspace-memory-archive',['t','w']);
 assert.ok(Buffer.byteLength(JSON.stringify(retained))<=4*1024*1024);assert.equal(retained!.at(-1).id,'new');
});

it('clearing legacy active beside a v2 head archives unique facts without resurrecting them',async()=>{
 const files=new MemoryArtifacts();const now=new Date();
 const fact={id:'legacy',workspaceId:'w',kind:'fact',content:'unique old-writer fact',createdAt:now,updatedAt:now};
 await files.write('workspace-memory',['t','w'],{format:2,entries:[]});await files.write('memory',['t','w'],[fact]);
 await new WorkspaceMemory(files).maintain('t','w');
 assert.equal(await files.read('memory',['t','w']),undefined);
 assert.equal((await files.read<any>('workspace-memory',['t','w'])).entries.length,0);
 assert.ok((await files.read<any[]>('workspace-memory-archive',['t','w']))?.some(entry=>entry.content===fact.content));
});

it('keyset maintenance reaches every workspace without rewriting healthy rows',async()=>{
 const files=new MemoryArtifacts();const now=new Date();
 for(let i=0;i<25;i++)await files.write('workspace-memory',['t',`w${i}`],{format:2,entries:[{id:'expired',workspaceId:`w${i}`,kind:'fact',content:'old',createdAt:now,updatedAt:now,ttl:new Date(0)}]});
 assert.equal(await maintainWorkspaceMemories(files,'t'),20);assert.equal(await maintainWorkspaceMemories(files,'t'),5);
 for(let i=0;i<25;i++){assert.equal((await files.read<any>('workspace-memory',['t',`w${i}`])).entries.length,0);assert.equal((await files.read<any[]>('workspace-memory-archive',['t',`w${i}`]))!.length,1);}
});
