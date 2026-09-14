import assert from 'node:assert/strict';
import { it } from 'node:test';
import { PostgresArtifacts } from '../src/postgres-artifacts.js';

it('serializes session owners across stores, rolls back state, and atomically increments shared memory', async () => {
  assert.ok(process.env.DIY_TEST_DATABASE_URL);
  const a = new PostgresArtifacts(process.env.DIY_TEST_DATABASE_URL!);
  const b = new PostgresArtifacts(process.env.DIY_TEST_DATABASE_URL!);
  await a.init(); await b.init();
  const scope = [crypto.randomUUID(), 'workspace', 'session'];
  try {
    await a.withLock(scope, async tx => {
      await assert.rejects(b.withLock(scope, async () => 1), /session_busy/);
      await tx.write('sessions', scope, { expiresAt: new Date(Date.now() + 60000), value: 1 });
    });
    await assert.rejects(a.withLock(scope, async tx => {
      await tx.write('sessions', scope, { value: 2 }); throw new Error('rollback');
    }), /rollback/);
    assert.equal((await b.read<{value:number}>('sessions', scope))?.value, 1);
    assert.equal(await b.read('sessions', ['another-tenant', ...scope.slice(1)]), undefined);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).withLock([...scope, String(i)], tx =>
      tx.update<number>('memory', scope.slice(0,2), n => (n ?? 0) + 1))));
    assert.equal(await a.read('memory', scope.slice(0,2)), 20);
    await a.write('expired', scope, { value: 3 }, new Date(Date.now() - 1000));
    assert.equal(await b.read('expired', scope), undefined);
  } finally { await a.close(); await b.close(); }
});

import { AgentRuntime } from '../src/agent-runtime.js';
import {WorkspaceMemory} from '../src/workspace-memory.js';
import pg from 'pg';
it('multiple replicas can initialize an empty runtime database concurrently',async()=>{
 const admin=new pg.Pool({connectionString:process.env.DIY_TEST_DATABASE_URL!});
 const name='runtime_init_'+crypto.randomUUID().replaceAll('-','');const url=new URL(process.env.DIY_TEST_DATABASE_URL!);url.pathname='/'+name;
 const replicas=Array.from({length:4},()=>new PostgresArtifacts(url.toString()));
 await admin.query(`CREATE DATABASE "${name}"`);
 try{await Promise.all(replicas.map(files=>files.init()));await replicas[0]!.write('test',['tenant'],{value:1});assert.deepEqual(await replicas[3]!.read('test',['tenant']),{value:1});}
 finally{await Promise.all(replicas.map(files=>files.close()));await admin.query(`DROP DATABASE "${name}"`);await admin.end();}
});
it('memory hot/cold migration and appended state roll back with the session transaction',async()=>{
 const files=new PostgresArtifacts(process.env.DIY_TEST_DATABASE_URL!);await files.init();
 const tenant=crypto.randomUUID();const scope=[tenant,'w'];const now=new Date();
 const fact={id:'old',workspaceId:'w',kind:'fact' as const,content:'legacy fact',createdAt:now,updatedAt:now};
 const archive=[{...fact,id:'archive',archivedAt:now,expiresAt:new Date(Date.now()+86400000)}];
 const legacy={entries:[fact],archive};await files.write('workspace-memory',scope,legacy);
 try{
  await assert.rejects(files.withLock([...scope,'s'],async tx=>{
   await new WorkspaceMemory(tx).append(tenant,'w',{...fact,id:'new',content:'new fact'} as never);
   await tx.write('outbox',[...scope,'s','r'],{eventId:'event'});throw new Error('rollback');
  }),/rollback/);
  assert.deepEqual(await files.read('workspace-memory',scope),legacy);
  assert.equal(await files.read('workspace-memory-archive',scope),undefined);
  assert.equal((await files.list('outbox',tenant)).length,0);
  await files.withLock([...scope,'s'],tx=>new WorkspaceMemory(tx).append(tenant,'w',{...fact,id:'new',content:'new fact'} as never));
  const restored=new PostgresArtifacts(process.env.DIY_TEST_DATABASE_URL!);
  try{assert.equal((await restored.read<any>('workspace-memory',scope)).entries.length,2);assert.deepEqual(await restored.read('workspace-memory-archive',scope),archive);}finally{await restored.close();}
 }finally{await files.close();}
});
it('two runtime replicas keep all concurrent workspace turns and replay completed turns without model calls',async()=>{
 const url=process.env.DIY_TEST_DATABASE_URL!;const a=new PostgresArtifacts(url);const b=new PostgresArtifacts(url);await a.init();await b.init();
 const tenant=crypto.randomUUID();let calls=0;
 const fetchImpl:typeof fetch=async(_url,init)=>{calls++;const request=JSON.parse(String(init?.body));return Response.json({choices:[{message:{role:'assistant',content:'answer '+request.messages.at(-1).content}}],usage:{total_tokens:4}});};
 const first=new AgentRuntime({files:a,allowedModelOrigins:['http://model.local'],fetchImpl});const second=new AgentRuntime({files:b,allowedModelOrigins:['http://model.local'],fetchImpl});
 const snapshot={id:'profile',workspaceId:'workspace',systemPrompt:'answer',modelRoute:{provider:'custom',model:'test',baseUrl:'http://model.local'},mcpBindings:[],skillIds:[],governanceTier:'L1',name:'p'};
 const inputs=Array.from({length:12},(_,i)=>({tenantId:tenant,workspaceId:'workspace',sessionId:'s'+i,requestId:'r'+i,profileVersionId:'v',snapshot,input:'question '+i}));
 try{
  const results=await Promise.all(inputs.map((input,i)=>(i%2?first:second).run(input as never)));
  assert.equal((await a.read<{entries:unknown[]}>('workspace-memory',[tenant,'workspace']))?.entries.length,12);
  assert.equal((await a.list('outbox',tenant)).length,12);
  for(let i=0;i<inputs.length;i++)assert.deepEqual(await (i%2?second:first).run(inputs[i] as never),results[i]);
  assert.equal(calls,12);
 }finally{await first.close();await second.close();await a.close();await b.close();}
});

it('losing the PostgreSQL session lock aborts its transaction signal and prevents commit',async()=>{
 const url=new URL(process.env.DIY_TEST_DATABASE_URL!);const label='diy-lock-'+crypto.randomUUID();url.searchParams.set('application_name',label);
 const artifacts=new PostgresArtifacts(url.toString());await artifacts.init();const admin=new pg.Pool({connectionString:process.env.DIY_TEST_DATABASE_URL});
 const scope=[crypto.randomUUID(),'w','s'];let signaled=false;
 try{
  await assert.rejects(artifacts.withLock(scope,async tx=>{
   tx.signal?.addEventListener('abort',()=>{signaled=true;});
   await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'",[label]);
   await new Promise<void>(resolve=>{if(tx.signal?.aborted)resolve();else tx.signal?.addEventListener('abort',()=>resolve(),{once:true});});
   await tx.write('sessions',scope,{shouldNotCommit:true});
  }));
  assert.equal(signaled,true);assert.equal(await artifacts.read('sessions',scope),undefined);
 }finally{await artifacts.close();await admin.end();}
});
