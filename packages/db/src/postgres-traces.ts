import type pg from "pg";
import { isDeepStrictEqual } from "node:util";
import type { EvalTraceRecord } from "./types.js";

type TraceRow = { id: string; profile_id: string; profile_version_id: string; output: string; latency_ms: number;
  tool_calls: EvalTraceRecord["toolCalls"] | null; tokens_used: number | null; created_at: Date;
  task_id: string | null; eval_batch_id: string | null; task_set_hash: string | null;
  execution_source: EvalTraceRecord["executionSource"] | null; eval_scope: EvalTraceRecord["evalScope"] | null };
export type TraceQuery = (sql: string, params: unknown[]) => Promise<pg.QueryResult>;
const columns = "id, profile_id, profile_version_id, output, latency_ms, tool_calls, tokens_used, created_at, task_id, eval_batch_id, task_set_hash, execution_source, eval_scope";

function normalized(trace: EvalTraceRecord): EvalTraceRecord {
  return { id: trace.id, profileId: trace.profileId, profileVersionId: trace.profileVersionId, output: trace.output, latencyMs: trace.latencyMs,
    toolCalls: trace.toolCalls ?? [], tokensUsed: trace.tokensUsed ?? undefined, createdAt: new Date(trace.createdAt),
    taskId: trace.taskId ?? undefined, evalBatchId: trace.evalBatchId ?? undefined, taskSetHash: trace.taskSetHash ?? undefined,
    executionSource: trace.executionSource ?? undefined, evalScope: trace.evalScope ?? undefined };
}

function decode(row: TraceRow): EvalTraceRecord {
  return normalized({ id: row.id, profileId: row.profile_id as EvalTraceRecord["profileId"], profileVersionId: row.profile_version_id as EvalTraceRecord["profileVersionId"],
    output: row.output, latencyMs: row.latency_ms, toolCalls: row.tool_calls ?? undefined, tokensUsed: row.tokens_used ?? undefined, createdAt: row.created_at,
    taskId: row.task_id ?? undefined, evalBatchId: row.eval_batch_id ?? undefined, taskSetHash: row.task_set_hash ?? undefined,
    executionSource: row.execution_source ?? undefined, evalScope: row.eval_scope ?? undefined });
}

/** schemaIdent must already be SQL identifier quoted by the storage router. */
export async function insertTrace(query: TraceQuery, schemaIdent: string, entry: EvalTraceRecord, verifyDuplicate = false): Promise<void> {
  const result = await query(`INSERT INTO ${schemaIdent}.eval_traces (${columns})
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)
    ${verifyDuplicate ? "ON CONFLICT (id) DO NOTHING" : ""} RETURNING id`,
    [entry.id, entry.profileId, entry.profileVersionId, entry.output, entry.latencyMs, JSON.stringify(entry.toolCalls ?? []), entry.tokensUsed ?? null,
      entry.createdAt, entry.taskId ?? null, entry.evalBatchId ?? null, entry.taskSetHash ?? null, entry.executionSource ?? null, entry.evalScope ?? null]);
  if (verifyDuplicate && !result.rowCount) {
    const existing = await query(`SELECT ${columns} FROM ${schemaIdent}.eval_traces WHERE id = $1`, [entry.id]);
    if (!existing.rows[0] || !isDeepStrictEqual(decode(existing.rows[0] as TraceRow), normalized(entry))) throw new Error("legacy_trace_conflict");
  }
}

export async function readTraces(query: TraceQuery, schemaIdent: string, profileId: string, limit: number): Promise<EvalTraceRecord[]> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000) throw new Error("invalid_trace_limit");
  const result = await query(`SELECT ${columns} FROM ${schemaIdent}.eval_traces WHERE profile_id = $1
    AND created_at >= NOW() - INTERVAL '90 days' ORDER BY created_at DESC, id DESC LIMIT $2`, [profileId, limit]);
  return result.rows.map(row => decode(row as TraceRow));
}

export async function readLatestPinTrace(query: TraceQuery, schemaIdent: string, profileId: string, versionId: string): Promise<EvalTraceRecord | undefined> {
  const result = await query(`SELECT ${columns} FROM ${schemaIdent}.eval_traces
    WHERE profile_id=$1 AND profile_version_id=$2 AND eval_scope='profile'
    ORDER BY eval_batch_id DESC NULLS LAST, created_at DESC, id DESC LIMIT 1`, [profileId, versionId]);
  return result.rows[0] ? decode(result.rows[0] as TraceRow) : undefined;
}
