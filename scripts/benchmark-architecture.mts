/** Reproduce local architecture probes: node --import tsx scripts/benchmark-architecture.mts */
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import type {MemoryEntry, WorkspaceId} from '@diy-agent/domain';
import {MemoryStore} from '../packages/db/src/memory-store.js';
import {governMemory, type ArchivedMemory} from '../packages/dsh-memory-plugin/src/index.js';
import {HybridKbService, type KbSearchHit} from '../packages/kb-rag/src/index.js';
import {createControlPlaneServer} from '../services/control-plane/src/server.js';
import {MemoryArtifacts} from '../services/data-plane/src/artifact-store.js';
import {WorkspaceMemory} from '../services/data-plane/src/workspace-memory.js';

const bytes = (value: unknown) => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
const median = (values: number[]) => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)]!;

async function bootstrapProbe() {
  const store = new MemoryStore();
  const tenant = await store.createTenant({name:'isolated-architecture-probe'});
  const workspace = (await store.createWorkspace({tenantId:tenant.id}))!;
  const {profile,version} = (await store.createProfile({tenantId:tenant.id,workspaceId:workspace.id,profile:{}}))!;
  await store.pinProfile(profile.id,version.id);
  const session = (await store.createSession({tenantId:tenant.id,profileId:profile.id}))!;
  const calls: string[] = [];
  // Bind to the target: count calls across the store interface, not its internal method calls.
  const observed = new Proxy(store,{get(target,key) {
    const value = Reflect.get(target,key);
    return typeof value === 'function' ? (...args:unknown[]) => {
      calls.push(String(key)); return value.apply(target,args);
    } : value;
  }});
  const priorBind = process.env.DIY_BIND_HOST;
  process.env.DIY_BIND_HOST = '127.0.0.1';
  const cp = createControlPlaneServer({store:observed,authMode:'api_key',evolutionIntervalMs:0});
  if(priorBind === undefined) delete process.env.DIY_BIND_HOST;
  else process.env.DIY_BIND_HOST = priorBind;
  try {
    await once(cp.server,'listening');
    const started = performance.now();
    const response = await fetch(cp.baseUrl+'/sessions/resolve',{method:'POST',
      headers:{Authorization:`Bearer ${session.sessionToken}`,'Content-Type':'application/json'},
      body:JSON.stringify({sessionId:session.session.id,checkQuota:true}),signal:AbortSignal.timeout(5000)});
    const data = await response.json();
    const durationMs = performance.now()-started;
    assert.equal(response.status,200); assert.equal(data.snapshot.id,profile.id);
    assert.deepEqual(calls,['resolveSessionBootstrap']);
    return {externalStoreCalls:calls.length,methods:[...calls],httpStatus:response.status,durationMs,
      note:'One real loopback HTTP request over MemoryStore. This is interface call count, not PostgreSQL statement count.'};
  } finally {if(cp.server.listening) await cp.close();}
}

type Traffic = {readBytes:number;writeBytes:number;coldReadBytes:number;coldWriteBytes:number;reads:number;writes:number};
const emptyTraffic = ():Traffic => ({readBytes:0,writeBytes:0,coldReadBytes:0,coldWriteBytes:0,reads:0,writes:0});
class ObservedArtifacts extends MemoryArtifacts {
  traffic = emptyTraffic();
  reset() {this.traffic=emptyTraffic();}
  private coldBytes(kind:string,value:unknown) {
    if(kind==='workspace-memory-archive') return bytes(value);
    if(kind==='workspace-memory' && value && typeof value==='object' && 'archive' in value) return bytes(value.archive);
    return 0;
  }
  override async read<T>(kind:string,scope:string[]):Promise<T|undefined> {
    const value=await super.read<T>(kind,scope);
    this.traffic.reads++; this.traffic.readBytes+=bytes(value); this.traffic.coldReadBytes+=this.coldBytes(kind,value);
    return value;
  }
  override async write(kind:string,scope:string[],value:unknown,expiresAt?:Date) {
    this.traffic.writes++; this.traffic.writeBytes+=bytes(value); this.traffic.coldWriteBytes+=this.coldBytes(kind,value);
    return super.write(kind,scope,value,expiresAt);
  }
}

async function memoryProbe() {
  const workspaceId='isolated-memory' as WorkspaceId;
  const scope=['architecture-probe',workspaceId]; const now=Date.now();
  const entries:MemoryEntry[]=Array.from({length:40},(_,i)=>({id:`active-${i}`,workspaceId,kind:'fact',
    content:`Current fact ${i}`,createdAt:new Date(now-40000+i*1000),updatedAt:new Date(now-40000+i*1000)}));
  const archive:ArchivedMemory[]=Array.from({length:1000},(_,i)=>({id:`archived-${i}`,workspaceId,kind:'fact',
    content:`Historical fact ${i} `.padEnd(3800,'x'),createdAt:new Date(now-86400000),updatedAt:new Date(now-86400000),
    archivedAt:new Date(now-1000),expiresAt:new Date(now+86400000)}));
  const entry:MemoryEntry={id:'new-fact',workspaceId,kind:'fact',content:'Newest fact',createdAt:new Date(now),updatedAt:new Date(now)};
  const policy={workspaceId,maxEntries:1000,defaultTtlDays:90,dedupSimilarityThreshold:0.92,compactionTriggerCount:50};
  const samples=15;const warmup=3;
  const run=async (layout:'reconstructedPrevious'|'current') => {
    const durations:number[]=[];let traffic=emptyTraffic();
    for(let i=0;i<samples+warmup;i++) {
      const files=new ObservedArtifacts();
      if(layout==='current') {
        await files.write('workspace-memory',scope,{format:2,entries});
        await files.write('workspace-memory-archive',scope,archive);
      } else await files.write('workspace-memory',scope,{entries,archive});
      files.reset(); const started=performance.now();
      if(layout==='current') {
        const memory=new WorkspaceMemory(files);
        assert.ok((await memory.context(scope[0]!,workspaceId)).includes('Current fact 39'));
        await memory.append(scope[0]!,workspaceId,entry);
      } else {
        // Reconstruct the previous layout's two full reads and full write; not a historical executable.
        const head=await files.read<{entries:MemoryEntry[];archive:ArchivedMemory[]}>('workspace-memory',scope);
        head!.entries.filter(e=>!e.ttl||e.ttl.getTime()>Date.now()).slice(-20).map(e=>e.content).join('\n').slice(0,16000);
        await files.update<{entries:MemoryEntry[];archive:ArchivedMemory[]}>('workspace-memory',scope,previous=> {
          const result=governMemory(workspaceId,policy,[...previous!.entries,entry],previous!.archive);
          return {entries:result.entries,archive:result.archive};
        });
      }
      const elapsed=performance.now()-started;
      if(i>=warmup) {durations.push(elapsed);traffic={...files.traffic};}
      await files.close();
    }
    return {medianMs:median(durations),samples,perOperation:traffic};
  };
  const reconstructedPrevious=await run('reconstructedPrevious'); const current=await run('current');
  assert.equal(current.perOperation.coldReadBytes,0); assert.equal(current.perOperation.coldWriteBytes,0);
  assert.ok(reconstructedPrevious.perOperation.coldReadBytes>0);
  return {activeEntries:entries.length,archiveEntries:archive.length,serializedArchiveBytes:bytes(archive),
    reconstructedPrevious,current,
    note:'Isolated MemoryArtifacts; unchanged format-2 archive and one unique fact append, no retirement. Timed operations include JSON byte-count instrumentation; seeding excluded. Previous algorithm reconstructed from whole-payload read/read-update/govern/write, not historical end-to-end measurement. No DB/WAL/network or compaction-path speed claim.'};
}

async function knowledgeProbe() {
  const run=async (serial:boolean) => {
    let active=0,maxActive=0; const events:string[]=[];
    const read=async (name:string):Promise<KbSearchHit[]> => {
      active++;maxActive=Math.max(active,maxActive);events.push(name+':start');
      try {await new Promise(resolve=>setTimeout(resolve,30));return [];}
      finally {events.push(name+':end');active--;}
    };
    const kb=new HybridKbService({internal:{enabled:true},externalMcp:{serverName:'injected-readonly',transport:'streamable-http',
      url:'http://127.0.0.1/never-requested',sensitivity:'readonly'}},
      {search:()=>read('internal'),ingest:async()=>{throw new Error('probe_does_not_ingest');}},
      {search:()=>read('external')});
    try {
      const started=performance.now();
      if(serial) {await read('internal');await read('external');}
      else await kb.search('isolated-kb' as WorkspaceId,'probe');
      return {durationMs:performance.now()-started,maxActive,events};
    } finally {await kb.close();}
  };
  const reconstructedPrevious=await run(true);const current=await run(false);
  assert.equal(reconstructedPrevious.maxActive,1);assert.equal(current.maxActive,2);
  return {injectedDelayPerAdapterMs:30,reconstructedPrevious,current,
    note:'Two injected readonly adapters, no KB/embedding/MCP network. Serial control reconstructs previous scheduling. Wall times are a local illustrative sample, not a production SLO.'};
}

async function main() {
  const sessionBootstrap=await bootstrapProbe(); const memory=await memoryProbe(); const knowledgeBase=await knowledgeProbe();
  console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,
    sessionBootstrap,memory,knowledgeBase},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
