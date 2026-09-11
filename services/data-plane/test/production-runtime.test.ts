import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/agent-runtime.js';
import { LocalFiles } from '../src/local-files.js';

const profile = { id:'p', workspaceId:'w', systemPrompt:'Answer', modelRoute:{ provider:'custom',model:'test',baseUrl:'http://model.local/v1' }, skillIds:[],mcpBindings:[],governanceTier:'L1',name:'test' } as const;
it('rejects non-readonly external knowledge tools before evaluation retrieval', async () => {
  let retrievals=0;
  const runtime=new AgentRuntime({retrieve:async()=>{retrievals++;return '';}});
  const external={serverName:'kb',transport:'http',url:'https://kb.example/mcp',sensitivity:'normal'};
  try {
    await assert.rejects(runtime.run({tenantId:'t',workspaceId:'w',sessionId:'s',profileVersionId:'v',requestId:'eval',input:'query',ephemeral:true,
      snapshot:{...profile,kbConfig:{externalMcp:external}},mcpCatalog:[{...external,tenantId:'t',approvalStatus:'approved'}]} as never),/evaluation_readonly_tools_required/);
    assert.equal(retrievals,0);
  } finally {await runtime.close();}
});
it('replays a durable completed request after runtime restart without another model call', async () => {
  const dir = await mkdtemp(join(tmpdir(),'diy-idempotency-')); let calls=0;
  const fetchImpl: typeof fetch = async () => { calls++; return Response.json({choices:[{message:{role:'assistant',content:'answer'}}],usage:{total_tokens:8}}); };
  const files = new LocalFiles(dir);
  const first = new AgentRuntime({files,allowedModelOrigins:['http://model.local'],fetchImpl});
  const input = {tenantId:'t',workspaceId:'w',sessionId:'s',profileVersionId:'v',snapshot:profile,input:'request',requestId:'request-1'};
  try {
    const result = await first.run(input as never); await first.close();
    const second = new AgentRuntime({files,allowedModelOrigins:['http://model.local'],fetchImpl});
    try {
      assert.deepEqual(await second.run(input as never), result); assert.equal(calls,1);
      await assert.rejects(second.run({...input,input:'different'} as never), /idempotency_conflict/);
      const pending = await files.list('outbox','t'); assert.equal(pending.length,1);
    } finally { await second.close(); }
  } finally { await first.close(); await rm(dir,{recursive:true,force:true}); }
});
it('rejects request replay in an uncertain state rather than repeating external side effects', async () => {
  const dir=await mkdtemp(join(tmpdir(),'diy-uncertain-')); const files=new LocalFiles(dir);
  let calls=0; const runtime=new AgentRuntime({files,allowedModelOrigins:['http://model.local'],fetchImpl:async()=>{calls++;throw new Error('transport_failed');}});
  const input={tenantId:'t',workspaceId:'w',sessionId:'s',profileVersionId:'v',snapshot:profile,input:'request',requestId:'r'};
  try {
    await assert.rejects(runtime.run(input as never), /transport_failed/);
    await assert.rejects(runtime.run(input as never), /execution_outcome_unknown/); assert.equal(calls,1);
  } finally {await runtime.close();await rm(dir,{recursive:true,force:true});}
});
