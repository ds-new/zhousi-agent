import type { AccessPolicy, AgentProfile, McpCatalogEntry, ModelRoute, McpBinding } from "@diy-agent/domain";
import { McpConnectionPool, resolveApprovedBinding, type McpConnectionOptions } from "@diy-agent/dsh-mcp-pool-plugin";
import { governMemory, type ArchivedMemory } from "@diy-agent/dsh-memory-plugin";
import { createHash } from "node:crypto";
import { readLimitedJson } from "./http-utils.js";
import { MemoryArtifacts, type ArtifactStore } from "./artifact-store.js";
import { approvalScope, bindingHash, snapshotHash, type ApprovalScope, type ToolApproval } from "./tool-approval.js";

type Message = { role: string; content: string | null; tool_call_id?: string; tool_calls?: ToolCall[] };
export type AgentResult = { output:string; tokensUsed:number; toolCalls:Array<{name:string;ok:boolean}>; latencyMs:number; status?:"requires_approval"|"denied"; approvalId?:string; toolName?:string; arguments?:Record<string,unknown>; expiresAt?:Date };
type PendingCall = {call:ToolCall;name:string;bindingHash:string};
type LoopCheckpoint = {messages:Message[];tokensUsed:number;toolCalls:Array<{name:string;ok:boolean}>;turn:number;pending:PendingCall[];snapshotHash:string;elapsedMs:number;accountedTokens:number;accountedToolCalls:number};
type TurnRecord = {fingerprint:string;status:string;result?:AgentResult;checkpoint?:LoopCheckpoint;approvalId?:string};
type SessionState = {version:string;profileId:string;messages:Message[];expires:number};
type MemoryState = { entries:import("@diy-agent/domain").MemoryEntry[];archive:ArchivedMemory[] };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export interface AgentRunInput {
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  profileVersionId: string;
  snapshot: AgentProfile;
  input: string;
  policy?: AccessPolicy;
  mcpCatalog?: McpCatalogEntry[];
  ephemeral?: boolean;
  requestId?: string;
  signal?: AbortSignal;
  quotaAllowed?: boolean;
  skillHashes?: Record<string, string>;
}
export interface AgentRuntimeOptions {
  fetchImpl?: typeof fetch;
  allowedModelOrigins?: string[];
  resolveCredential?: (tenantId: string, ref: string) => Promise<string>;
  maxTurns?: number;
  maxSessions?: number;
  loadSkill?: (input: AgentRunInput, skillId: string) => Promise<string>;
  retrieve?: (input: AgentRunInput) => Promise<string>;
  files?: ArtifactStore;
  tenantId?: string;
  maxConcurrentRuns?: number;
  maxDurationMs?: number;
  mcp?: McpConnectionOptions;
  strictPolicy?:boolean;
  approvalTtlMs?:number;
}

/** Small bounded model/tool loop. All model and tool I/O stays on the Data Plane. */
export class AgentRuntime {
  private active = 0;
  private closed = false;
  private pool: McpConnectionPool;
  private files: ArtifactStore;
  constructor(private options: AgentRuntimeOptions = {}) {
    this.files = options.files ?? new MemoryArtifacts();
    this.pool = new McpConnectionPool({ ...options.mcp, resolveCredential: options.resolveCredential });
  }

  async run(input: AgentRunInput) {
    if (this.closed) throw new Error("runtime_closed");
    if (this.options.tenantId && input.tenantId !== this.options.tenantId) throw new Error("tenant_mismatch");
    if (![input.tenantId,input.workspaceId,input.sessionId,input.profileVersionId,input.input].every(v => typeof v === "string" && v.trim()) ||
        input.snapshot?.workspaceId !== input.workspaceId || input.input.length > 32000) throw new Error("invalid_agent_scope");
    // Keep headroom in the 24-client pool for durable intents and outbox delivery.
    if (this.active >= Math.min(this.options.maxConcurrentRuns ?? 16,16)) throw new Error("runtime_capacity_exceeded");
    const scope=[input.tenantId,input.workspaceId,input.sessionId];
    const requestId=input.requestId ?? crypto.randomUUID();
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId)) throw new Error("invalid_request_id");
    const turnScope=[...scope,requestId];
    const fingerprint=createHash("sha256").update(JSON.stringify([input.snapshot.id,input.profileVersionId,input.input])).digest("hex");
    input={...input,requestId,signal:AbortSignal.any([AbortSignal.timeout(this.options.maxDurationMs ?? 120000),...(input.signal?[input.signal]:[])])};
    this.active++;
    try {
      return await this.files.withLock(scope,async files=>{
        if(files.signal)input={...input,signal:AbortSignal.any([input.signal!,files.signal])};
        let checkpoint:LoopCheckpoint|undefined;
        let approved:ToolApproval|undefined;
        let denial:AgentResult|undefined;
        if (!input.ephemeral) {
          const previous=await files.read<TurnRecord>("turns",turnScope);
          if(previous){
            if(previous.fingerprint!==fingerprint)throw new Error("idempotency_conflict");
            if(previous.status==="completed"||previous.status==="denied")return previous.result!;
            if(previous.status!=="requires_approval"||!previous.checkpoint||!previous.approvalId)throw new Error("execution_outcome_unknown");
            if(previous.checkpoint.snapshotHash!==snapshotHash(input.snapshot))throw new Error("approval_snapshot_changed");
            const approval=await files.read<ToolApproval>("approvals",[...turnScope,previous.approvalId]);
            if(!approval)throw new Error("approval_not_found");
            if(approval.expiresAt.getTime()<=Date.now())throw new Error("approval_expired");
            if(approval.status==="pending")return previous.result!;
            if(approval.status==="denied")denial={...previous.result!,status:"denied",output:"",approvalId:approval.id};
            else if(approval.status==="approved")approved=approval;
            else throw new Error("approval_not_pending");
            checkpoint=previous.checkpoint;
            const remaining=(this.options.maxDurationMs??120000)-checkpoint.elapsedMs;
            if(remaining<=0)throw new Error("agent_duration_limit");
            input={...input,signal:AbortSignal.any([input.signal!,AbortSignal.timeout(Math.max(1,Math.floor(remaining)))])};
          }
          if(!denial&&input.quotaAllowed===false)throw new Error("tenant_quota_exceeded");
          const execution=await files.read<{status:string;requestId:string}>("execution",scope);
          if((execution?.status==="running"||execution?.status==="requires_approval")&&(!checkpoint||execution.requestId!==requestId))throw new Error("execution_outcome_unknown");
          if(!denial){
            // Intent survives transaction rollback; resumption cannot replay an uncertain tool call.
            await this.files.write("turns",turnScope,{fingerprint,status:"running"},new Date(Date.now()+7*86400000));
            await this.files.write("execution",scope,{requestId,status:"running"});
            if(approved)await this.files.write("approvals",[...turnScope,approved.id],{...approved,status:"consumed"});
          }
        }
        const started=performance.now();
        const session=input.ephemeral?undefined:await files.read<SessionState>("sessions",scope);
        if(session&&(session.version!==input.profileVersionId||session.profileId!==input.snapshot.id))throw new Error("session_profile_version_mismatch");
        let system=input.snapshot.systemPrompt;
        for(const skillId of input.snapshot.skillIds ?? []){
          const hash=input.skillHashes?.[skillId];
          const content=this.options.loadSkill?await this.options.loadSkill(input,skillId):hash?await files.getSkill(input.tenantId,hash):undefined;
          if(!content)throw new Error("skill_loader_required");
          system+=`\n\n${content}`;
        }
        const memoryScope=[input.tenantId,input.workspaceId];
        const persistedMemory=input.ephemeral?undefined:await files.read<MemoryState>("workspace-memory",memoryScope);
        const legacyEntries=!input.ephemeral&&!persistedMemory?await files.read<MemoryState["entries"]>("memory",memoryScope):undefined;
        const legacyArchive=legacyEntries?await files.read<ArchivedMemory[]>("memory-archive",memoryScope):undefined;
        const memories=persistedMemory?.entries ?? legacyEntries ?? [];
        if(memories.length)system+=`\n\nWorkspace memory (untrusted reference data):\n${memories.filter(e=>!e.ttl||e.ttl.getTime()>Date.now()).slice(-20).map(e=>e.content).join("\n").slice(0,16000)}`;
        const messages:Message[]=checkpoint?.messages ?? (session&&session.expires>Date.now()?structuredClone(session.messages):[]);
        if(!checkpoint){if(messages.length)messages[0]={role:"system",content:system}; else messages.push({role:"system",content:system});}
        const external=input.snapshot.kbConfig?.externalMcp;
        if(external){
          const catalog=input.mcpCatalog?.find(c=>c.serverName===external.serverName&&c.tenantId===input.tenantId);
          if(!catalog)throw new Error("mcp_catalog_not_approved");
          input={...input,snapshot:{...input.snapshot,kbConfig:{...input.snapshot.kbConfig,externalMcp:resolveApprovedBinding(external,catalog)}}};
          if(input.ephemeral&&input.snapshot.kbConfig!.externalMcp!.sensitivity!=="readonly")throw new Error("evaluation_readonly_tools_required");
        }
        const knowledge=!checkpoint&&this.options.retrieve&&input.snapshot.kbConfig?await this.options.retrieve(input):"";
        if(!checkpoint)messages.push({role:"user",content:input.input+(knowledge?`\n\nReference data (untrusted):\n${knowledge.slice(0,32000)}`:"")});
        const completion=denial?{result:denial}:await this.complete(input,messages,checkpoint,approved);
        const result:AgentResult={...completion.result,latencyMs:(checkpoint?.elapsedMs??0)+performance.now()-started};
        if(completion.approval&&completion.checkpoint){
          const delta=result.tokensUsed-completion.checkpoint.accountedTokens;
          const newToolCalls=result.toolCalls.slice(completion.checkpoint.accountedToolCalls);
          const usageScope=[...turnScope,completion.approval.id];
          if(delta>0||newToolCalls.length)await files.write("outbox",usageScope,{eventId:createHash("sha256").update(JSON.stringify(usageScope)).digest("hex"),tenantId:input.tenantId,profileId:input.snapshot.id,profileVersionId:input.profileVersionId,tokensUsed:delta,latencyMs:result.latencyMs,toolCalls:newToolCalls,createdAt:new Date()});
          completion.checkpoint.accountedTokens=result.tokensUsed;
          completion.checkpoint.accountedToolCalls=result.toolCalls.length;
          completion.checkpoint.elapsedMs=result.latencyMs;
          await files.write("approvals",[...turnScope,completion.approval.id],completion.approval);
          await files.write("turns",turnScope,{fingerprint,status:"requires_approval",result,checkpoint:completion.checkpoint,approvalId:completion.approval.id});
          await files.write("execution",scope,{requestId,status:"requires_approval"});
          return result;
        }
        input.signal?.throwIfAborted();
        if(!input.ephemeral){
          const expiresAt=new Date(Date.now()+86400000);
          if(result.status!=="denied")await files.write("sessions",scope,{profileId:input.snapshot.id,version:input.profileVersionId,messages,expires:expiresAt.getTime()},expiresAt);
          if(result.status!=="denied")await files.update<MemoryState>("workspace-memory",memoryScope,previous=>{
            const entries=previous?.entries ?? legacyEntries ?? [];
            entries.push({id:requestId,workspaceId:input.workspaceId as never,kind:"episodic",content:`${input.input}\n${result.output}`.slice(0,4000),createdAt:new Date(),updatedAt:new Date(),sourceSessionId:input.sessionId as never});
            const governed=governMemory(input.workspaceId,{workspaceId:input.workspaceId as never,maxEntries:1000,defaultTtlDays:90,dedupSimilarityThreshold:0.92,compactionTriggerCount:50},entries,previous?.archive ?? legacyArchive);
            return {entries:governed.entries,archive:governed.archive};
          });
          await files.write("turns",turnScope,{fingerprint,status:result.status==="denied"?"denied":"completed",result},new Date(Date.now()+7*86400000));
          await files.write("execution",scope,{requestId,status:"completed"},new Date(Date.now()+7*86400000));
          await files.write("outbox",turnScope,{eventId:createHash("sha256").update(JSON.stringify(turnScope)).digest("hex"),tenantId:input.tenantId,profileId:input.snapshot.id,profileVersionId:input.profileVersionId,tokensUsed:result.tokensUsed-(checkpoint?.accountedTokens??0),latencyMs:result.latencyMs,toolCalls:result.toolCalls.slice(checkpoint?.accountedToolCalls??0),createdAt:new Date()});
        }
        return result;
      });
    } finally {this.active--;}
  }

  async approve(input:ApprovalScope & {decision:"allow"|"deny";reviewer?:string}) {
    if(this.options.tenantId&&input.tenantId!==this.options.tenantId)throw new Error("tenant_mismatch");
    if(input.decision!=="allow"&&input.decision!=="deny")throw new Error("invalid_approval_decision");
    return this.files.withLock([input.tenantId,input.workspaceId,input.sessionId],async files=>{
      const turn=await files.read<TurnRecord>("turns",[input.tenantId,input.workspaceId,input.sessionId,input.requestId]);
      const approval=await files.read<ToolApproval>("approvals",approvalScope(input));
      if(!turn||!approval)throw new Error("approval_not_found");
      if(turn.status!=="requires_approval"||approval.status!=="pending")throw new Error("approval_not_pending");
      if(turn.approvalId!==input.approvalId)throw new Error("approval_not_found");
      if(approval.expiresAt.getTime()<=Date.now())throw new Error("approval_expired");
      const updated={...approval,status:input.decision==="allow"?"approved" as const:"denied" as const,reviewer:input.reviewer,reviewedAt:new Date()};
      await files.write("approvals",approvalScope(input),updated);
      if(input.decision==="deny"){
        const scope=[input.tenantId,input.workspaceId,input.sessionId];
        const result={...turn.result!,status:"denied",output:""};
        await files.write("turns",[...scope,input.requestId],{fingerprint:turn.fingerprint,status:"denied",result});
        await files.write("execution",scope,{requestId:input.requestId,status:"completed"});
        if(turn.checkpoint){
          const messages=structuredClone(turn.checkpoint.messages);
          for(const pending of turn.checkpoint.pending)messages.push({role:"tool",tool_call_id:pending.call.id,content:"Tool execution denied by reviewer."});
          messages.push({role:"assistant",content:"The requested action was denied by a reviewer."});
          const expiresAt=new Date(Date.now()+86400000);
          await files.write("sessions",scope,{profileId:approval.profileId,version:approval.profileVersionId,messages,expires:expiresAt.getTime()},expiresAt);
        }
      }
      return updated;
    });
  }

  /** Explicit operator recovery. The interrupted request remains terminal and cannot be replayed. */
  async recoverSession(input:{tenantId:string;workspaceId:string;sessionId:string;expectedRequestId:string}) {
    if(this.options.tenantId&&input.tenantId!==this.options.tenantId)throw new Error("tenant_mismatch");
    const scope=[input.tenantId,input.workspaceId,input.sessionId];
    return this.files.withLock(scope,async files=>{
      const execution=await files.read<{requestId:string;status:string}>("execution",scope);
      if(!execution||execution.requestId!==input.expectedRequestId||!["running","requires_approval"].includes(execution.status))throw new Error("execution_request_mismatch");
      const turnScope=[...scope,input.expectedRequestId];
      const turn=await files.read<TurnRecord>("turns",turnScope);
      await files.write("turns",turnScope,{...turn,status:"abandoned"});
      await files.write("execution",scope,{requestId:input.expectedRequestId,status:"recovered"});
      return {recovered:true};
    });
  }

  private async complete(input:AgentRunInput,messages:Message[],checkpoint?:LoopCheckpoint,grant?:ToolApproval):Promise<{result:AgentResult;checkpoint?:LoopCheckpoint;approval?:ToolApproval}> {
    const state:LoopCheckpoint=checkpoint ?? {messages,tokensUsed:0,toolCalls:[],turn:0,pending:[],snapshotHash:snapshotHash(input.snapshot),elapsedMs:0,accountedTokens:0,accountedToolCalls:0};
    const leases:Array<Awaited<ReturnType<McpConnectionPool["connect"]>>>=[];
    const registered=new Map<string,{name:string;binding:McpBinding;hash:string;lease:typeof leases[number]}>();
    const tools:unknown[]=[];
    try{
      for(const binding of input.snapshot.mcpBindings??[]){
        const catalog=input.mcpCatalog?.find(c=>c.serverName===binding.serverName&&c.tenantId===input.tenantId);
        if(catalog?.approvalStatus!=="approved")throw new Error("mcp_catalog_not_approved");
        const resolved=resolveApprovedBinding(binding,catalog);
        const lease=await this.pool.connect(resolved,input,{signal:input.signal});leases.push(lease);
        for(const tool of (await lease.listTools({signal:input.signal})).tools){
          const alias=`tool_${registered.size}`;
          registered.set(alias,{name:tool.name,binding:resolved,hash:bindingHash(resolved,tool.name,tool.inputSchema),lease});
          tools.push({type:"function",function:{name:alias,description:[resolved.description,tool.description].filter(Boolean).join("\n"),parameters:tool.inputSchema}});
        }
      }
      for(;;){
        while(state.pending.length){
          input.signal?.throwIfAborted();
          const pending=state.pending[0]!;const call=pending.call;
          const tool=registered.get(call.function.name);
          if(!tool||tool.name!==pending.name||tool.hash!==pending.bindingHash)throw new Error("approval_binding_changed");
          const name=`mcp__${tool.binding.serverName}__${tool.name}`;
          const sensitivity=tool.binding.sensitivity??"normal";
          if(input.ephemeral&&sensitivity!=="readonly")throw new Error("evaluation_readonly_tools_required");
          const rule=[...(input.policy?.rules??[])].reverse().find(r=>(!r.sensitivity||r.sensitivity===sensitivity)&&
            new RegExp("^"+r.toolPattern.split("*").map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join(".*")+"$","i").test(name));
          const effect=rule?.effect??(this.options.strictPolicy||sensitivity==="high"?"deny":"allow");
          const args=JSON.parse(call.function.arguments);
          if(!args||typeof args!=="object"||Array.isArray(args))throw new Error("invalid_tool_arguments");
          if(grant&&(grant.toolName!==name||grant.bindingHash!==tool.hash||grant.profileVersionId!==input.profileVersionId||grant.snapshotHash!==state.snapshotHash||
            JSON.stringify(grant.arguments)!==JSON.stringify(args)||grant.expiresAt.getTime()<=Date.now()))throw new Error("approval_binding_changed");
          if(effect==="deny")throw new Error("policy_denied");
          if(effect==="ask"){
            if(!grant){
              if(input.ephemeral)throw new Error("policy_ask_required");
              const approval:ToolApproval={id:crypto.randomUUID(),toolName:name,arguments:args,bindingHash:tool.hash,
                profileId:input.snapshot.id,profileVersionId:input.profileVersionId,snapshotHash:state.snapshotHash,expiresAt:new Date(Date.now()+(this.options.approvalTtlMs??900000)),status:"pending"};
              return {approval,checkpoint:state,result:{output:"",tokensUsed:state.tokensUsed,toolCalls:state.toolCalls,latencyMs:0,status:"requires_approval",approvalId:approval.id,toolName:name,arguments:args,expiresAt:approval.expiresAt}};
            }
            if(grant.toolName!==name||grant.bindingHash!==tool.hash||grant.profileVersionId!==input.profileVersionId||grant.snapshotHash!==state.snapshotHash||
              JSON.stringify(grant.arguments)!==JSON.stringify(args)||grant.expiresAt.getTime()<=Date.now())throw new Error("approval_binding_changed");
          }
          grant=undefined;
          const result=await tool.lease.callTool({name:tool.name,arguments:args},{signal:input.signal,timeout:30000});
          state.toolCalls.push({name,ok:!result.isError});
          const content=JSON.stringify(result);if(content.length>64000)throw new Error("tool_output_limit");
          messages.push({role:"tool",tool_call_id:call.id,content});state.pending.shift();
        }
        input.signal?.throwIfAborted();
        if(state.turn>=(this.options.maxTurns??8))throw new Error("agent_turn_limit");
        if(JSON.stringify(messages).length>128000)throw new Error("agent_context_limit");
        const response=await this.model(input.snapshot.modelRoute,input.tenantId,messages,tools,input.signal);
        state.turn++;
        const usage=response.usage?.total_tokens??0;if(!Number.isSafeInteger(usage)||usage<0)throw new Error("model_invalid_usage");state.tokensUsed+=usage;
        const message=response.choices?.[0]?.message;if(!message)throw new Error("model_invalid_output");
        if(!message.tool_calls?.length){
          if(typeof message.content!=="string"||!message.content.trim())throw new Error("model_invalid_output");
          messages.push({role:"assistant",content:message.content});return {result:{output:message.content,tokensUsed:state.tokensUsed,toolCalls:state.toolCalls,latencyMs:0}};
        }
        if(message.tool_calls.length>16)throw new Error("agent_tool_call_limit");
        messages.push({role:"assistant",content:message.content??null,tool_calls:message.tool_calls});
        state.pending=message.tool_calls.map(call=>{const tool=registered.get(call.function.name);if(!tool)throw new Error("agent_unknown_tool");return {call,name:tool.name,bindingHash:tool.hash};});
      }
    }finally{await Promise.allSettled(leases.map(lease=>lease.release()));}
  }

  private async model(route: ModelRoute, tenantId: string, messages: Message[], tools: unknown[], signal?:AbortSignal, depth = 0): Promise<{ choices: Array<{ message: Message }>; usage?: { total_tokens: number } }> {
    if (depth > 4) throw new Error("model_fallback_limit");
    if (!route?.model || !route.baseUrl) throw new Error("model_base_url_required");
    const url = new URL(route.baseUrl.replace(/\/$/, "") + "/chat/completions");
    if (!(this.options.allowedModelOrigins ?? []).includes(url.origin)) throw new Error("model_origin_not_allowed");
    const secret = route.apiKeyRef ? await this.options.resolveCredential?.(tenantId, route.apiKeyRef) : undefined;
    if (route.apiKeyRef && !secret) throw new Error("model_credential_missing");
    let res: Response;
    try {
      res = await (this.options.fetchImpl ?? fetch)(url, { method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(30_000),...(signal?[signal]:[])]),
        headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify({ model: route.model, messages, ...(tools.length ? { tools } : {}), max_tokens: 4096, stream: false }),
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (route.fallback && error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) return this.model(route.fallback, tenantId, messages, tools, signal, depth + 1);
      throw error;
    }
    if (res.status >= 500 && route.fallback) return this.model(route.fallback, tenantId, messages, tools, signal, depth + 1);
    if (!res.ok) throw new Error(`model_http_${res.status}`);
    return await readLimitedJson(res);
  }
  async close() { this.closed=true; await this.pool.close(); }
}
