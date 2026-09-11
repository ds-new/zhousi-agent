import type {ArtifactStore} from './artifact-store.js';
export interface UsageEvent {eventId:string;tenantId:string;profileId:string;profileVersionId:string;tokensUsed:number;}
/** Durable at-least-once delivery; the CP records each event once. No conversation text leaves the DP. */
export class UsageDispatcher {
  private flushing?:Promise<void>;
  private timer?:ReturnType<typeof setInterval>;
  constructor(private files:ArtifactStore,private tenantId:string,private url:string,private token:string,private fetchImpl:typeof fetch=fetch){}
  start(){this.timer=setInterval(()=>{void this.flush().catch(()=>console.error('usage_delivery_deferred'));},5000);this.timer.unref();}
  flush():Promise<void>{
    if(this.flushing)return this.flushing;
    this.flushing=(async()=>{
      for(const item of await this.files.list<UsageEvent>('outbox',this.tenantId,100)){
        const response=await this.fetchImpl(`${this.url.replace(/\/$/,'')}/usage/events`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.token}`},body:JSON.stringify(item.value)});
        if(!response.ok)throw new Error('usage_delivery_failed');
        await this.files.remove('outbox',item.scope);
      }
    })().finally(()=>{this.flushing=undefined;});
    return this.flushing;
  }
  async close(){if(this.timer)clearInterval(this.timer);await this.flushing?.catch(()=>{});}
}
