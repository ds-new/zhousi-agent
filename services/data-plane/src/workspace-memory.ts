import type {MemoryEntry,MemoryGovernancePolicy} from '@diy-agent/domain';
import {governMemory,type ArchivedMemory} from '@diy-agent/dsh-memory-plugin';
import type {ArtifactStore} from './artifact-store.js';

type Head={format?:2;entries:MemoryEntry[];archive?:ArchivedMemory[]};
const headKind='workspace-memory';
const archiveKind='workspace-memory-archive';
const identity=(item:MemoryEntry)=>JSON.stringify([item.id,item.updatedAt,item.kind,item.content,item.sourceSessionId]);
const policy=(workspaceId:string):MemoryGovernancePolicy=>({workspaceId:workspaceId as never,maxEntries:1000,defaultTtlDays:90,dedupSimilarityThreshold:0.92,compactionTriggerCount:50});

/** Owns context order, hot/cold layout and governance under the caller's transaction. */
export class WorkspaceMemory {
  constructor(private files:ArtifactStore){}

  async context(tenantId:string,workspaceId:string):Promise<string>{
    const scope=[tenantId,workspaceId];
    const head=await this.files.read<Head>(headKind,scope);
    const entries=head?.entries??await this.files.read<MemoryEntry[]>('memory',scope)??[];
    const now=Date.now();
    if(entries.some(entry=>entry.workspaceId!==workspaceId))throw new Error('memory_workspace_mismatch');
    return entries.filter(entry=>(entry.ttl?.getTime()??entry.createdAt.getTime()+90*86400000)>now)
      .sort((a,b)=>b.updatedAt.getTime()-a.updatedAt.getTime()).slice(0,20).map(entry=>entry.content).join('\n').slice(0,16000);
  }

  async append(tenantId:string,workspaceId:string,entry:MemoryEntry):Promise<void>{
    if(entry.workspaceId!==workspaceId)throw new Error('memory_workspace_mismatch');
    await this.change(tenantId,workspaceId,entry);
  }

  async maintain(tenantId:string,workspaceId:string):Promise<void>{await this.change(tenantId,workspaceId);}

  private async change(tenantId:string,workspaceId:string,entry?:MemoryEntry){
    const scope=[tenantId,workspaceId];
    await this.files.withRecordLock(headKind,scope,async files=>{
      const head=await files.read<Head>(headKind,scope);
      const legacy=!head||head.format!==2||!entry?await files.read<MemoryEntry[]>('memory',scope):undefined;
      let legacyFound=legacy!==undefined;
      const entries=head?.entries??legacy??[];
      const before=entry?undefined:JSON.stringify(entries);
      const result=governMemory(workspaceId,policy(workspaceId),entry?[entry,...entries]:[...entries]);
      const now=Date.now();
      let activeBytes=32+result.entries.reduce((sum,item)=>sum+Buffer.byteLength(JSON.stringify(item))+1,0);
      while(activeBytes>512*1024&&result.entries.length){
        const retired=result.entries.pop()!;activeBytes-=Buffer.byteLength(JSON.stringify(retired))+1;
        result.archive.push({...retired,archivedAt:new Date(now),expiresAt:new Date(now+30*86400000)});
      }
      const migrating=head?.format!==2;
      // No archive read on an ordinary append that retires nothing.
      if(migrating||result.archive.length||!entry){
        const saved=await files.read<ArchivedMemory[]>(archiveKind,scope);
        const legacyArchive=migrating||!entry?await files.read<ArchivedMemory[]>('memory-archive',scope):undefined;
        legacyFound ||= legacyArchive!==undefined;
        const activeIds=new Set(result.entries.map(identity));
        // A v2 head is authoritative; preserve old-writer-only facts as cold evidence, never reactivate them.
        const orphaned=head?(legacy??[]).filter(item=>!activeIds.has(identity(item))).map(item=>({...item,archivedAt:new Date(now),expiresAt:new Date(now+30*86400000)})):[];
        const prior=[...(saved??[]),...(migrating?head?.archive??[]:[]),...(legacyArchive??[]),...orphaned];
        if(prior.some(item=>item.workspaceId!==workspaceId))throw new Error('memory_workspace_mismatch');
        const unique=new Map<string,ArchivedMemory>();
        for(const item of [...prior,...result.archive]){
          if(item.expiresAt.getTime()<=now)continue;
          const key=identity(item);
          if(!unique.has(key))unique.set(key,item);
        }
        const archive=[...unique.values()];
        const sizes=archive.map(item=>Buffer.byteLength(JSON.stringify(item))+1);
        let bytes=2+sizes.reduce((sum,size)=>sum+size,0);let start=0;
        while(bytes>4*1024*1024&&start<archive.length)bytes-=sizes[start++]!;
        const retained=archive.slice(start);
        if((saved||retained.length)&&(!saved||retained.length!==saved.length||retained.some((item,i)=>item!==saved[i])))await files.write(archiveKind,scope,retained);
      }
      if(entry||migrating||JSON.stringify(result.entries)!==before)await files.write(headKind,scope,{format:2,entries:result.entries});
      if(migrating||legacyFound){await files.remove('memory',scope);await files.remove('memory-archive',scope);}
      // Head and archive migration commit together in the production adapter.
    });
  }
}

const kinds=[headKind,'memory','memory-archive'];
const cursors=new WeakMap<ArtifactStore,Map<string,{kind:number;after:string}>>();
/** Keyset scan reads scope only; lack of changes never forces a payload rewrite for scheduling. */
export async function maintainWorkspaceMemories(files:ArtifactStore,tenantId:string){
  let tenants=cursors.get(files);if(!tenants){tenants=new Map();cursors.set(files,tenants);}
  const memory=new WorkspaceMemory(files);
  const cursor=tenants.get(tenantId)??{kind:0,after:''};let processed=0;
  while(cursor.kind<kinds.length&&processed<20){
    const remaining=20-processed;
    const rows=await files.scan(kinds[cursor.kind]!,tenantId,cursor.after,remaining);
    for(const row of rows){await memory.maintain(tenantId,row.scope[1]!);processed++;cursor.after=row.key;}
    if(rows.length<remaining){cursor.kind++;cursor.after='';}
  }
  tenants.set(tenantId,cursor.kind===kinds.length?{kind:0,after:''}:cursor);
  return processed;
}
