import pg from 'pg';
import { artifactKey, decodeArtifact, SkillArtifacts, type ArtifactStore } from './artifact-store.js';

/** Customer-owned runtime DB. Session + memory + outbox commit on the same transaction client. */
export class PostgresArtifacts extends SkillArtifacts implements ArtifactStore {
  private pool: pg.Pool;
  constructor(url: string, private client?: pg.PoolClient, pool?: pg.Pool,readonly signal?:AbortSignal) {
    super();
    this.pool = pool ?? new pg.Pool({ connectionString: url, max: 24, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    if (!pool) this.pool.on('error', () => console.error('runtime_database_connection_error'));
  }
  async init() {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('diy_runtime_schema', 0))");
      await client.query(`CREATE SCHEMA IF NOT EXISTS diy_runtime;
        CREATE TABLE IF NOT EXISTS diy_runtime.artifacts (
          tenant_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
          scope JSONB NOT NULL, payload JSONB NOT NULL, expires_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, kind, key));
        CREATE INDEX IF NOT EXISTS artifacts_expiry ON diy_runtime.artifacts(expires_at) WHERE expires_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS artifacts_delivery ON diy_runtime.artifacts(tenant_id,kind,updated_at)`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => { broken = true; });
      throw error;
    } finally { client.release(broken); }
  }
  private query(text: string, values?: unknown[]) { return (this.client ?? this.pool).query(text, values); }
  async read<T>(kind: string, scope: string[]): Promise<T | undefined> {
    const r = await this.query('SELECT payload FROM diy_runtime.artifacts WHERE tenant_id=$1 AND kind=$2 AND key=$3 AND (expires_at IS NULL OR expires_at > now())', [scope[0], kind, artifactKey(kind, scope)]);
    return r.rows[0] ? decodeArtifact<T>(r.rows[0].payload) : undefined;
  }
  async write(kind: string, scope: string[], value: unknown, expiresAt?: Date) {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new Error('artifact_size_limit');
    await this.query(`INSERT INTO diy_runtime.artifacts(tenant_id,kind,key,scope,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(tenant_id,kind,key) DO UPDATE SET payload=EXCLUDED.payload, expires_at=EXCLUDED.expires_at, updated_at=now()`,
      [scope[0], kind, artifactKey(kind, scope), JSON.stringify(scope), data, expiresAt ?? null]);
  }
  async remove(kind: string, scope: string[]) {
    await this.query('DELETE FROM diy_runtime.artifacts WHERE tenant_id=$1 AND kind=$2 AND key=$3', [scope[0], kind, artifactKey(kind, scope)]);
  }
  async update<T>(kind: string, scope: string[], change: (value: T | undefined) => T): Promise<T> {
    return this.withRecordLock(kind,scope,async tx=>{
      const value=change(await tx.read<T>(kind,scope));await tx.write(kind,scope,value);return value;
    });
  }
  async withRecordLock<T>(kind:string,scope:string[],operation:(store:ArtifactStore)=>Promise<T>):Promise<T>{
    if(!this.client)return this.withLock(['record',kind,...scope],tx=>tx.withRecordLock(kind,scope,operation));
    await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[artifactKey(kind,scope)]);
    return operation(this);
  }
  async scan(kind:string,tenantId:string,after='',limit=20){
    artifactKey(kind,[tenantId]);
    const result=await this.query('SELECT key,scope FROM diy_runtime.artifacts WHERE tenant_id=$1 AND kind=$2 AND key>$3 AND (expires_at IS NULL OR expires_at>now()) ORDER BY key LIMIT $4',[tenantId,kind,after,Math.max(1,Math.min(limit,1000))]);
    return result.rows.map(row=>({key:row.key as string,scope:row.scope as string[]}));
  }
  async withLock<T>(scope: string[], operation: (store: ArtifactStore) => Promise<T>): Promise<T> {
    if (this.client) throw new Error('nested_runtime_transaction');
    const client = await this.pool.connect();
    let broken = false;
    const cancelled=new AbortController();
    const onError = () => { broken = true; cancelled.abort(new Error("runtime_lock_lost")); };
    client.on('error', onError);
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '180s'");
      const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [artifactKey('locks', scope)]);
      if (!lock.rows[0]?.locked) throw new Error('session_busy');
      const result = await operation(new PostgresArtifacts('', client, this.pool,cancelled.signal));
      if (broken) throw new Error('runtime_lock_lost');
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => { broken = true; });
      throw error;
    } finally { client.removeListener('error', onError); client.release(broken); }
  }
  async list<T>(kind: string, tenantId: string, limit = 100) {
    artifactKey(kind, [tenantId]);
    const r = await this.query('SELECT scope,payload FROM diy_runtime.artifacts WHERE tenant_id=$1 AND kind=$2 AND (expires_at IS NULL OR expires_at > now()) ORDER BY updated_at LIMIT $3', [tenantId, kind, Math.max(1, Math.min(limit, 1000))]);
    return r.rows.map(row => ({ scope: row.scope as string[], value: decodeArtifact<T>(row.payload) }));
  }
  async purgeExpired() {
    await this.query('DELETE FROM diy_runtime.artifacts WHERE (tenant_id,kind,key) IN (SELECT tenant_id,kind,key FROM diy_runtime.artifacts WHERE expires_at <= now() LIMIT 1000)');
  }
  async health() { await this.query('SELECT 1'); }
  async close() { if (!this.client) await this.pool.end(); }
}
