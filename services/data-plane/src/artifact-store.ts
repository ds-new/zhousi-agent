import { createHash } from 'node:crypto';

export interface ArtifactStore {
  readonly signal?:AbortSignal;
  read<T>(kind: string, scope: string[]): Promise<T | undefined>;
  write(kind: string, scope: string[], value: unknown, expiresAt?: Date): Promise<void>;
  remove(kind: string, scope: string[]): Promise<void>;
  update<T>(kind: string, scope: string[], change: (value: T | undefined) => T): Promise<T>;
  withLock<T>(scope: string[], operation: (store: ArtifactStore) => Promise<T>): Promise<T>;
  list<T>(kind: string, tenantId: string, limit?: number): Promise<Array<{ scope: string[]; value: T }>>;
  putSkill(tenantId: string, content: string): Promise<string>;
  getSkill(tenantId: string, contentHash: string): Promise<string>;
  health(): Promise<void>;
  close(): Promise<void>;
}

export function artifactKey(kind: string, scope: string[]): string {
  if (!/^[a-z-]+$/.test(kind) || !scope.length || scope.some(s => typeof s !== 'string' || !s || s.length > 512)) throw new Error('invalid_artifact_scope');
  return createHash('sha256').update(JSON.stringify([kind, ...scope])).digest('hex');
}
export function decodeArtifact<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), (key, item) => typeof item === 'string' && /(?:At|ttl)$/.test(key) && /^\d{4}-\d\d-\d\dT/.test(item) ? new Date(item) : item);
}
export abstract class SkillArtifacts {
  abstract read<T>(kind: string, scope: string[]): Promise<T | undefined>;
  abstract write(kind: string, scope: string[], value: unknown, expiresAt?: Date): Promise<void>;
  async putSkill(tenantId: string, content: string) {
    if (Buffer.byteLength(content) > 262144) throw new Error('skill_content_limit');
    const hash = createHash('sha256').update(content).digest('hex');
    await this.write('skills', [tenantId, hash], { content });
    return hash;
  }
  async getSkill(tenantId: string, hash: string) {
    const artifact = await this.read<{ content: string }>('skills', [tenantId, hash]);
    if (!artifact || createHash('sha256').update(artifact.content).digest('hex') !== hash) throw new Error('skill_content_missing_or_corrupt');
    return artifact.content;
  }
}

export class MemoryArtifacts extends SkillArtifacts implements ArtifactStore {
  private entries = new Map<string, { kind:string; scope:string[]; value:unknown; expiresAt?:Date }>();
  private locks = new Set<string>();
  async read<T>(kind:string, scope:string[]):Promise<T|undefined> {
    const record=this.entries.get(artifactKey(kind,scope));
    return record && (!record.expiresAt || record.expiresAt.getTime()>Date.now()) ? structuredClone(record.value) as T : undefined;
  }
  async write(kind:string,scope:string[],value:unknown,expiresAt?:Date) { this.entries.set(artifactKey(kind,scope),{kind,scope,value:structuredClone(value),expiresAt}); }
  async remove(kind:string,scope:string[]) { this.entries.delete(artifactKey(kind,scope)); }
  async withLock<T>(scope:string[],fn:(store:ArtifactStore)=>Promise<T>):Promise<T> {
    const key=artifactKey('locks',scope); if(this.locks.has(key))throw new Error('session_busy'); this.locks.add(key);
    try{return await fn(this);}finally{this.locks.delete(key);}
  }
  async update<T>(kind:string,scope:string[],fn:(v:T|undefined)=>T):Promise<T> {return this.withLock(['update',kind,...scope],async()=>{const value=fn(await this.read<T>(kind,scope));await this.write(kind,scope,value);return value;});}
  async list<T>(kind:string,tenantId:string,limit=100) {return [...this.entries.values()].filter(r=>r.kind===kind&&r.scope[0]===tenantId&&(!r.expiresAt||r.expiresAt.getTime()>Date.now())).slice(0,limit).map(r=>({scope:r.scope,value:structuredClone(r.value) as T}));}
  async health(){} async close(){}
}
