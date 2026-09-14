import { createServer } from 'node:http';
import { LocalFiles } from './local-files.js';
import { PostgresArtifacts } from './postgres-artifacts.js';
import type { ArtifactStore } from './artifact-store.js';
import { decryptVault, deriveVaultKey } from '@diy-agent/dsh-vault-plugin';
import { AgentRuntime, type AgentRunInput } from './agent-runtime.js';
import { UsageDispatcher } from './usage-dispatcher.js';
import {maintainMemory} from './memory-maintenance.js';
import { readJsonBody, readLimitedJson, errorStatus } from './http-utils.js';
import { createKbRuntime,handleKbDocumentHttp,handleKbSearchHttp,validateInternalToken,type KbRuntime,type KbRuntimeDeps } from '@diy-agent/dsh-kb-plugin';
import {getCachedProfileSync,handleProfilePinnedWebhook} from '@diy-agent/dsh-profile-sync-plugin';

export interface DataPlaneServerOptions {
 port?:number;internalToken?:string;tenantId?:string;production?:boolean;serviceAccountToken?:string;
 kbRuntime?:KbRuntime;kbRuntimeDeps?:KbRuntimeDeps;agentRuntime?:AgentRuntime;files?:ArtifactStore;controlPlaneUrl?:string;
}
export interface DataPlaneServer {server:ReturnType<typeof createServer>;baseUrl:string;kbRuntime:KbRuntime;close:()=>Promise<void>;}

export function createDataPlaneServer(options:DataPlaneServerOptions={}):DataPlaneServer{
 const internalToken=options.internalToken??process.env.DIY_DATA_PLANE_INTERNAL_TOKEN;
 const tenantId=options.tenantId;
 const cpUrl=options.controlPlaneUrl??process.env.DIY_CONTROL_PLANE_URL??'http://127.0.0.1:9878';
 const files=options.files??new LocalFiles(process.env.DIY_DATA_DIRECTORY??'.diy-data');
 const resolveCredential=async (tenant:string,ref:string)=>{
  if(tenantId&&tenant!==tenantId)throw new Error('tenant_mismatch');
  const material=process.env.DIY_VAULT_KEY_MATERIAL;const blob=await files.read<string>('vault',[tenant]);
  if(!material||!blob)throw new Error('vault_not_configured');
  const value=decryptVault(blob,deriveVaultKey(material,tenant))[ref.replace(/^vault:\/\//,'')];
  if(!value)throw new Error('credential_missing');return value;
 };
 const modelOrigins=(process.env.DIY_MODEL_ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean);
 const mcp={allowStdio:!options.production||process.env.DIY_ALLOW_STDIO_MCP==='true',
  allowedHttpOrigins:options.production?(process.env.DIY_MCP_ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean):undefined,resolveCredential};
 const embeddingProvider=process.env.DIY_EMBEDDING_BASE_URL?async(text:string,tenant?:string,searchOptions?:{signal?:AbortSignal})=>{
  if(!tenant)throw new Error('embedding_tenant_required');
  const url=new URL(process.env.DIY_EMBEDDING_BASE_URL!.replace(/\/$/,'')+'/embeddings');
  if(!modelOrigins.includes(url.origin))throw new Error('model_origin_not_allowed');
  const ref=process.env.DIY_EMBEDDING_API_KEY_REF;
  const secret=ref?await resolveCredential(tenant,ref):undefined;
  const response=await fetch(url,{method:'POST',signal:AbortSignal.any([AbortSignal.timeout(30000),...(searchOptions?.signal?[searchOptions.signal]:[])]),redirect:'error',headers:{'Content-Type':'application/json',...(secret?{Authorization:`Bearer ${secret}`}:{})},body:JSON.stringify({model:process.env.DIY_EMBEDDING_MODEL,input:text,dimensions:128})});
  if(!response.ok)throw new Error('embedding_request_failed');
  const result=await readLimitedJson<{data:Array<{embedding:number[]}>}>(response);return result.data?.[0]?.embedding;
 }:undefined;
 const kbRuntime=options.kbRuntime??createKbRuntime({...options.kbRuntimeDeps,requireTenant:options.production??options.kbRuntimeDeps?.requireTenant,
  ...(embeddingProvider?{embeddingProvider}:{}),mcpConnectionOptions:{...mcp,...options.kbRuntimeDeps?.mcpConnectionOptions}});
 const runtime=options.agentRuntime??new AgentRuntime({files,tenantId,strictPolicy:options.production,mcp,resolveCredential,allowedModelOrigins:modelOrigins,
  retrieve:async input=>JSON.stringify(await kbRuntime.search({tenantId:input.tenantId as never,workspaceId:input.workspaceId as never,sessionId:input.sessionId,signal:input.signal,timeoutMs:30000,query:input.input,kbConfig:input.snapshot.kbConfig!}))});
 const dispatcher=tenantId&&options.serviceAccountToken?new UsageDispatcher(files,tenantId,cpUrl,options.serviceAccountToken):undefined;
 dispatcher?.start();
 let maintenance:Promise<unknown>|undefined;
 const maintenanceTimer=tenantId?setInterval(()=>{
  if(maintenance)return;
  maintenance=maintainMemory(files,tenantId).then(async()=>{if(files instanceof PostgresArtifacts)await files.purgeExpired();}).catch(()=>console.error('memory_maintenance_failed')).finally(()=>{maintenance=undefined;});
 },60000):undefined;
 maintenanceTimer?.unref();
 let closing=false;
 const server=createServer((req,res)=>{
  const requestId=crypto.randomUUID();const started=performance.now();
  const abort=new AbortController();req.on('aborted',()=>abort.abort());res.on('close',()=>{if(!res.writableEnded)abort.abort();});
  const respond=(status:number,body:unknown)=>{if(res.writableEnded||res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json','X-Request-Id':requestId});res.end(JSON.stringify(body));};
  void(async()=>{
   const path=new URL(req.url??'/','http://localhost').pathname;
   if(req.method==='GET'&&path==='/health')return respond(200,{ok:true,plane:'data'});
   if(req.method==='GET'&&path==='/ready'){
    if(closing)return respond(503,{ok:false});try{await files.health();}catch{return respond(503,{ok:false});}return respond(200,{ok:true});
   }
   if(closing)return respond(503,{error:'draining'});
   const session=path.match(/^\/sessions\/([^/]+)\/turn$/);
   if(req.method==='POST'&&session){
    if(!req.headers.authorization?.startsWith('Bearer sess_'))return respond(401,{error:'invalid_session_token'});
    const body=await readJsonBody(req);const id=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:body.requestId;
    if(options.production&&typeof id!=='string')return respond(400,{error:'idempotency_key_required'});
    if(typeof body.input!=='string'||!body.input.trim())return respond(400,{error:'input_required'});
    const verified=await fetch(cpUrl.replace(/\/$/,'')+'/sessions/resolve',{method:'POST',redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)]),headers:{'Content-Type':'application/json',Authorization:req.headers.authorization},body:JSON.stringify({sessionId:session[1],checkQuota:true})});
    if(!verified.ok)return respond(verified.status,{error:'invalid_session_token'});
    const context=await readLimitedJson<any>(verified);
    if(tenantId&&context.tenantId!==tenantId)return respond(403,{error:'tenant_mismatch'});
    const result=await runtime.run({...context,input:body.input,requestId:id as string|undefined,signal:abort.signal,quotaAllowed:context.quota?.allowed,
     sessionId:context.session.id,workspaceId:context.session.workspaceId,profileVersionId:context.session.profileVersionId});
    void dispatcher?.flush().catch(()=>console.error('usage_delivery_deferred'));
    return respond((result as {status?:string}).status==='requires_approval'?202:200,result);
   }
   if(!validateInternalToken(req,internalToken))return respond(401,{error:'unauthorized'});
   const cache=path.match(/^\/profile-sync\/cache\/([^/]+)\/([^/]+)$/);
   if(req.method==='GET'&&cache){const cached=getCachedProfileSync(cache[1]!,cache[2]!);return respond(cached?200:404,cached??{error:'cache_miss'});}
   const body=await readJsonBody(req);
   const payload=(path==='/webhooks/profile-sync'?(body.payload??body):body) as Record<string,unknown>;
   if(tenantId&&body.tenantId!==undefined&&body.tenantId!==tenantId)return respond(403,{error:'tenant_mismatch'});
   if(tenantId&&payload.tenantId!==tenantId)return respond(403,{error:'tenant_mismatch'});
   if(req.method==='POST'&&path==='/tool-approvals'){
    if(!internalToken)return respond(503,{error:'internal_token_required'});
    return respond(200,await runtime.approve(body as unknown as Parameters<typeof runtime.approve>[0]));
   }
   if(req.method==='POST'&&path==='/sessions/recover'){
    if(!internalToken)return respond(503,{error:'internal_token_required'});
    return respond(200,await runtime.recoverSession(body as unknown as Parameters<typeof runtime.recoverSession>[0]));
   }
   if(req.method==='POST'&&path==='/agent/run'){
    if(!internalToken)return respond(503,{error:'internal_token_required'});
    return respond(200,await runtime.run({...body,signal:abort.signal} as unknown as AgentRunInput));
   }
   if(req.method==='PUT'&&path==='/skills/content'){
    if(!internalToken)return respond(503,{error:'internal_token_required'});
    if(typeof body.tenantId!=='string'||typeof body.content!=='string'||!body.content.trim())return respond(400,{error:'missing_fields'});
    return respond(201,{contentHash:await files.putSkill(body.tenantId,body.content)});
   }
   if(req.method==='POST'&&path==='/webhooks/profile-sync'){
    const entry=handleProfilePinnedWebhook(payload as unknown as Parameters<typeof handleProfilePinnedWebhook>[0]);return respond(entry?201:400,entry??{error:'missing_snapshot'});
   }
   if(req.method==='POST'&&(path==='/kb/search'||path==='/kb/documents')){
    const result=path==='/kb/search'?await handleKbSearchHttp(kbRuntime,body):await handleKbDocumentHttp(kbRuntime,body);return respond(result.status,result.body);
   }
   return respond(404,{error:'not_found'});
  })().catch(error=>{
   const status=errorStatus(error);console.error(JSON.stringify({event:'request_failed',requestId,status,latencyMs:Math.round(performance.now()-started)}));
   respond(status,{error:error instanceof Error && status<500?error.message:'execution_failed',requestId});
  });
 });
 server.requestTimeout=150000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
 server.listen(options.port??0,process.env.DIY_BIND_HOST??'127.0.0.1');
 return{server,kbRuntime,get baseUrl(){const a=server.address();return a&&typeof a!=='string'?`http://127.0.0.1:${a.port}`:'';},close:async()=>{
  if(closing)return;closing=true;
  if(maintenanceTimer)clearInterval(maintenanceTimer);
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await maintenance;await dispatcher?.close();await runtime.close();await kbRuntime.close();await files.close();
 }};
}
export async function startDataPlaneFromEnv():Promise<DataPlaneServer>{
 const dev=process.env.DIY_ALLOW_INSECURE_DEV==='true';
 if(!process.env.DIY_DATA_PLANE_INTERNAL_TOKEN)throw new Error('data_plane_internal_token_required');
 if(!dev&&(!process.env.DIY_TENANT_ID||!process.env.DIY_RUNTIME_DATABASE_URL||!process.env.DIY_CONTROL_PLANE_URL||(process.env.DIY_SERVICE_ACCOUNT_TOKEN?.length??0)<32||!process.env.DIY_SERVICE_ACCOUNT_TOKEN?.startsWith('diy_sa_')||process.env.DIY_DATA_PLANE_INTERNAL_TOKEN.length<32))throw new Error('production_data_plane_configuration_required');
 const files=process.env.DIY_RUNTIME_DATABASE_URL?new PostgresArtifacts(process.env.DIY_RUNTIME_DATABASE_URL):new LocalFiles(process.env.DIY_DATA_DIRECTORY??'.diy-data');
 if(files instanceof PostgresArtifacts)await files.init();
 const dp=createDataPlaneServer({port:Number(process.env.DIY_DATA_PLANE_PORT??3080),production:!dev,tenantId:process.env.DIY_TENANT_ID,serviceAccountToken:process.env.DIY_SERVICE_ACCOUNT_TOKEN,files});
 await new Promise<void>((resolve,reject)=>{dp.server.once('listening',resolve);dp.server.once('error',reject);});return dp;
}
