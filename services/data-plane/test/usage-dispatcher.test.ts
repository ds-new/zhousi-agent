import assert from 'node:assert/strict';import {it} from 'node:test';
import {MemoryArtifacts} from '../src/artifact-store.js';import {UsageDispatcher} from '../src/usage-dispatcher.js';
it('keeps an outbox event on outage and retries the same identity without sending another tenant or conversation',async()=>{
 const files=new MemoryArtifacts();const own={eventId:'e1',tenantId:'a',profileId:'p',profileVersionId:'v',tokensUsed:8};
 await files.write('outbox',['a','w','s','r'],own);await files.write('outbox',['b','w','s','r'],{...own,tenantId:'b'});
 let outage=true;const sent:unknown[]=[];const dispatcher=new UsageDispatcher(files,'a','http://control.local','diy_sa_test',async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return new Response(null,{status:outage?503:201});});
 await assert.rejects(dispatcher.flush(),/usage_delivery_failed/);assert.equal((await files.list('outbox','a')).length,1);
 outage=false;await Promise.all([dispatcher.flush(),dispatcher.flush()]);
 assert.deepEqual(sent,[own,own]);assert.equal((await files.list('outbox','a')).length,0);assert.equal((await files.list('outbox','b')).length,1);await dispatcher.close();
});
