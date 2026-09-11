import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { artifactKey, decodeArtifact, SkillArtifacts, type ArtifactStore } from './artifact-store.js';

const locks = new Set<string>();
const writes = new Map<string, Promise<void>>();
/** Single-process development backend. Production uses PostgresArtifacts for cross-replica transactions. */
export class LocalFiles extends SkillArtifacts implements ArtifactStore {
  constructor(private root: string) { super(); this.root = resolve(root); }
  private path(kind: string, scope: string[]) {
    artifactKey(kind, scope);
    // Preserve existing content addresses for migration compatibility.
    return join(this.root, kind, createHash('sha256').update(JSON.stringify(scope)).digest('hex') + '.json');
  }
  async read<T>(kind: string, scope: string[]): Promise<T | undefined> {
    const path = this.path(kind, scope);
    await writes.get(path);
    try {
      const stored = decodeArtifact<any>(JSON.parse(await readFile(path, 'utf8')));
      if (stored?.artifactFormat === 1) {
        if (JSON.stringify(stored.scope) !== JSON.stringify(scope)) throw new Error('artifact_scope_mismatch');
        if (stored.expiresAt && stored.expiresAt.getTime() <= Date.now()) return undefined;
        return stored.value;
      }
      return stored;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async write(kind: string, scope: string[], value: unknown, expiresAt?: Date) {
    const path = this.path(kind, scope);
    const serialized = JSON.stringify({ artifactFormat: 1, scope, value, expiresAt });
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error('artifact_size_limit');
    const pending = (writes.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(join(this.root, kind), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try { await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, path); }
      finally { await unlink(temporary).catch(() => {}); }
    });
    writes.set(path, pending);
    try { await pending; } finally { if (writes.get(path) === pending) writes.delete(path); }
  }
  async remove(kind: string, scope: string[]) {
    const path = this.path(kind, scope); await writes.get(path);
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async withLock<T>(scope: string[], operation: (store: ArtifactStore) => Promise<T>): Promise<T> {
    const key = `${this.root}:${artifactKey('locks', scope)}`;
    if (locks.has(key)) throw new Error('session_busy');
    locks.add(key);
    try { return await operation(this); } finally { locks.delete(key); }
  }
  async update<T>(kind: string, scope: string[], change: (value: T | undefined) => T): Promise<T> {
    return this.withLock(['update', ...scope, kind], async () => {
      const result = change(await this.read<T>(kind, scope)); await this.write(kind, scope, result); return result;
    });
  }
  async list<T>(kind: string, tenantId: string, limit = 100) {
    artifactKey(kind, [tenantId]);
    const result: Array<{scope: string[]; value: T}> = [];
    const names = await readdir(join(this.root, kind)).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of names.filter(n => n.endsWith('.json'))) {
      const stored = decodeArtifact<any>(JSON.parse(await readFile(join(this.root, kind, name), 'utf8')));
      if (stored.artifactFormat === 1 && stored.scope[0] === tenantId && (!stored.expiresAt || stored.expiresAt.getTime() > Date.now())) result.push({ scope: stored.scope, value: stored.value });
      if (result.length >= limit) break;
    }
    return result;
  }
  async health() { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
  async close() { await Promise.all([...writes.entries()].filter(([path]) => path.startsWith(this.root + '/')).map(([, p]) => p)); }
}
