import type {AccessPolicy,McpBinding} from '@diy-agent/domain';
import {resolveApprovedBinding} from '@diy-agent/dsh-mcp-pool-plugin';
import type {AgentRunInput} from './agent-runtime.js';
import {snapshotHash} from './tool-approval.js';

export type RuntimeTool={name:string;policyName:string;sensitivity:NonNullable<McpBinding['sensitivity']>;hash:string;
  execute:(args:Record<string,unknown>)=>Promise<{isError?:boolean;[key:string]:unknown}>};

export function toolEffect(policy:AccessPolicy|undefined,name:string,sensitivity:string,strict=false){
  const rule=[...(policy?.rules??[])].reverse().find(rule=>(!rule.sensitivity||rule.sensitivity===sensitivity)&&
    new RegExp('^'+rule.toolPattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$','i').test(name));
  return rule?.effect??(strict||sensitivity==='high'?'deny':'allow');
}

/** Keeps retrieval mode and approved configuration identical for auto and model-selected tools. */
export class SessionKnowledge {
  private input:AgentRunInput;
  readonly definition={type:'function',function:{name:'kb_search',description:'Search this Workspace knowledge base for evidence. Query only when relevant.',
    parameters:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}}};
  constructor(input:AgentRunInput,private retrieve:((input:AgentRunInput)=>Promise<string>)|undefined,private strict=false){
    this.input=input;
    const external=input.snapshot.kbConfig?.externalMcp;
    if(external){
      const catalog=input.mcpCatalog?.find(entry=>entry.tenantId===input.tenantId&&entry.serverName===external.serverName);
      if(!catalog)throw new Error('mcp_catalog_not_approved');
      const binding=resolveApprovedBinding(external,catalog);
      if(input.ephemeral&&binding.sensitivity!=='readonly')throw new Error('evaluation_readonly_tools_required');
      this.input={...input,snapshot:{...input.snapshot,kbConfig:{...input.snapshot.kbConfig,externalMcp:binding}}};
    }
  }
  get enabled(){const config=this.input.snapshot.kbConfig;return Boolean(config&&(config.internal?.enabled||config.externalMcp));}
  get mode(){return this.input.snapshot.kbConfig?.retrievalMode??'tool';}
  private get sensitivity(){return this.input.snapshot.kbConfig?.externalMcp?.sensitivity??'readonly';}

  private async search(args:Record<string,unknown>){
    if(typeof args.query!=='string'||!args.query.trim()||args.query.length>32000||Object.keys(args).some(key=>key!=='query'))throw new Error('invalid_kb_query');
    if(!this.retrieve)throw new Error('kb_runtime_required');
    this.input.signal?.throwIfAborted();
    const text=await this.retrieve({...this.input,input:args.query});
    this.input.signal?.throwIfAborted();
    if(typeof text!=='string'||text.length>64000)throw new Error('tool_output_limit');
    return text;
  }
  async auto(){
    if(!this.enabled||this.mode!=='auto')return '';
    const effect=toolEffect(this.input.policy,'kb_search',this.sensitivity,this.strict);
    if(effect!=='allow')throw new Error(effect==='ask'?'policy_ask_required':'policy_denied');
    return this.search({query:this.input.input});
  }
  tool():RuntimeTool|undefined{
    if(!this.enabled||this.mode==='auto')return undefined;
    return {name:'kb_search',policyName:'kb_search',sensitivity:this.sensitivity,hash:snapshotHash([this.input.snapshot.kbConfig,this.definition]),
      execute:async args=>({content:[{type:'text',text:await this.search(args)}]})};
  }
}
