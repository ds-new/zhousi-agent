import {governMemory,type ArchivedMemory} from '@diy-agent/dsh-memory-plugin';
import type {MemoryEntry} from '@diy-agent/domain';
import type {ArtifactStore} from './artifact-store.js';
type WorkspaceMemory={entries:MemoryEntry[];archive:ArchivedMemory[]};
/** Bounded sweep, independent of user turns. Updated rows rotate to the back of the next scan. */
export async function maintainMemory(files:ArtifactStore,tenantId:string){
 const workspaces=await files.list<WorkspaceMemory>('workspace-memory',tenantId,20);
 for(const item of workspaces)await files.update<WorkspaceMemory>('workspace-memory',item.scope,previous=>{
  const result=governMemory(item.scope[1]!,{workspaceId:item.scope[1] as never,maxEntries:1000,defaultTtlDays:90,dedupSimilarityThreshold:0.92,compactionTriggerCount:50},previous?.entries??[],previous?.archive??[]);
  return {entries:result.entries,archive:result.archive};
 });
 return workspaces.length;
}
