import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolRequest, Tool } from "@modelcontextprotocol/sdk/types.js";
import { shouldWarmPool, type McpBinding } from "@diy-agent/domain";
import { poolKey, type PoolContext } from "./index.js";

interface Entry {
  tenantId: string;
  ready: Promise<Client>;
  client: Client;
  transport?: StdioClientTransport | StreamableHTTPClientTransport;
  controller: AbortController;
  users: number;
  lastUsedAt: number;
  warm: boolean;
  closing?: Promise<void>;
}

export interface McpConnectionOptions {
  maxConnectionsPerTenant?: number;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxTools?: number;
  maxToolPages?: number;
  maxResponseBytes?: number;
  /** Set false in production unless the launcher runs inside an operator-managed sandbox. */
  allowStdio?: boolean;
  /** Undefined permits development endpoints; [] rejects every HTTP endpoint. */
  allowedHttpOrigins?: string[];
  resolveCredential?: (tenantId: string, ref: string) => Promise<string>;
}

/** Real protocol connections. Pending handshakes reserve capacity and coalesce concurrent callers. */
export class McpConnectionPool {
  private entries = new Map<string, Entry>();
  private closed = false;
  private retiring = new Set<Entry>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private options: McpConnectionOptions = {}) {
    for (const [name, value] of Object.entries(options)) {
      if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`mcp_invalid_option:${name}`);
    }
    this.timer = setInterval(() => {
      for (const [key, entry] of this.entries) {
        if (entry.users === 0 && Date.now() - entry.lastUsedAt >= (options.idleTimeoutMs ?? 300_000)) {
          this.entries.delete(key);
          void this.dispose(entry);
        }
      }
    }, Math.min(options.idleTimeoutMs ?? 300_000, 60_000));
    this.timer.unref();
  }

  async connect(binding: McpBinding, context: PoolContext, options: { signal?: AbortSignal } = {}) {
    if (this.closed) throw new Error("mcp_pool_closed");
    options.signal?.throwIfAborted();
    this.validateBinding(binding);
    const baseKey = poolKey(binding, context);
    const warm = shouldWarmPool(binding);
    const key = warm ? baseKey : `${baseKey}:${crypto.randomUUID()}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if ([...new Set([...this.entries.values(), ...this.retiring])].filter(e => e.tenantId === context.tenantId).length >= (this.options.maxConnectionsPerTenant ?? 10)) throw new Error("mcp_warm_pool_limit_exceeded");
      const client = new Client({ name: "diy-agent", version: "0.1.0" });
      entry = { tenantId: context.tenantId!, ready: Promise.resolve(client), client, controller: new AbortController(), users: 0, lastUsedAt: Date.now(), warm };
      const created = entry;
      client.onclose = () => {
        if (this.entries.get(key) === created) this.entries.delete(key);
        created.controller.abort(new Error("mcp_connection_closed"));
      };
      this.entries.set(key, entry);
      entry.ready = this.open(binding, entry).catch(async error => {
        if (this.entries.get(key) === created) this.entries.delete(key);
        await this.dispose(created);
        throw error;
      });
    }
    const selected = entry;
    selected.users++;
    const release = async () => {
      if (released) return;
      released = true;
      selected.users--;
      selected.lastUsedAt = Date.now();
      if ((!warm || !connected) && selected.users === 0) {
        if (this.entries.get(key) === selected) this.entries.delete(key);
        await this.dispose(selected);
      }
    };
    let released = false;
    let connected = false;
    let client: Client;
    try {
      client = await abortable(selected.ready, options.signal);
      if (this.closed) throw new Error("mcp_pool_closed");
      selected.controller.signal.throwIfAborted();
      connected = true;
    } catch (error) { await release(); throw error; }
    const requestOptions = (request: { signal?: AbortSignal; timeout?: number } = {}) => {
      if (released) throw new Error("mcp_lease_released");
      const timeout = Math.min(request.timeout ?? this.options.requestTimeoutMs ?? 30_000, this.options.requestTimeoutMs ?? 30_000);
      if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("mcp_request_timeout_invalid");
      const signals = [selected.controller.signal, options.signal, request.signal].filter((s): s is AbortSignal => Boolean(s));
      return { timeout, maxTotalTimeout: timeout, signal: AbortSignal.any(signals) };
    };
    return {
      client,
      release,
      listTools: async (request: { signal?: AbortSignal } = {}) => {
        const tools: Tool[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        const deadline = AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000);
        const signal = request.signal ? AbortSignal.any([deadline, request.signal]) : deadline;
        for (let page = 0; page < (this.options.maxToolPages ?? 8); page++) {
          const response = await client.listTools(cursor ? { cursor } : undefined, requestOptions({ signal }));
          tools.push(...response.tools);
          if (tools.length > (this.options.maxTools ?? 128)) throw new Error("mcp_tool_limit_exceeded");
          if (!response.nextCursor) return { tools };
          if (cursors.has(response.nextCursor)) throw new Error("mcp_tool_pagination_invalid");
          cursors.add(response.nextCursor);
          cursor = response.nextCursor;
        }
        throw new Error("mcp_tool_page_limit_exceeded");
      },
      callTool: (params: CallToolRequest["params"], request: { signal?: AbortSignal; timeout?: number } = {}) => client.callTool(params, undefined, requestOptions(request)),
    };
  }

  private validateBinding(binding: McpBinding): void {
    if (!binding.serverName?.trim() || !["stdio", "streamable-http"].includes(binding.transport)) throw new Error("mcp_binding_invalid");
    if (binding.transport === "stdio") {
      if (this.options.allowStdio === false) throw new Error("mcp_stdio_disabled");
      if (!binding.command?.trim() || binding.command.includes("\0")) throw new Error("mcp_command_required");
      if (binding.args && (!Array.isArray(binding.args) || binding.args.length > 128 || binding.args.some(arg => typeof arg !== "string" || arg.includes("\0")))) throw new Error("mcp_args_invalid");
    } else {
      this.validateUrl(binding.url);
    }
    if (binding.poolScope && !["tenant", "workspace", "session"].includes(binding.poolScope)) throw new Error("mcp_pool_scope_invalid");
    if (binding.sensitivity && !["normal", "high", "readonly"].includes(binding.sensitivity)) throw new Error("mcp_sensitivity_invalid");
    if (binding.envRef && (typeof binding.envRef !== "object" || Array.isArray(binding.envRef))) throw new Error("mcp_credential_ref_invalid");
    const entries = Object.entries(binding.envRef ?? {});
    if (binding.transport === "streamable-http" && new Set(entries.map(([name]) => name.toLowerCase())).size !== entries.length) throw new Error("mcp_credential_name_invalid");
    if (entries.length > 32) throw new Error("mcp_credential_limit_exceeded");
    for (const [name, ref] of entries) {
      if (typeof ref !== "string" || !ref.trim() || ref.length > 1024) throw new Error("mcp_credential_ref_invalid");
      if (binding.transport === "stdio" ? !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) : !/^[A-Za-z0-9_-]+$/.test(name) || /^(host|connection|content-length|content-type|accept|mcp-.*)$/i.test(name)) throw new Error("mcp_credential_name_invalid");
    }
  }

  private validateUrl(value: string | URL | undefined): URL {
    let url: URL;
    try { url = new URL(value!); } catch { throw new Error("mcp_url_invalid"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("mcp_url_invalid");
    if (this.options.allowedHttpOrigins && !this.options.allowedHttpOrigins.includes(url.origin)) throw new Error("mcp_http_origin_not_allowed");
    return url;
  }

  private async open(binding: McpBinding, entry: Entry): Promise<Client> {
    const timeout = setTimeout(() => entry.controller.abort(new Error("mcp_connect_timeout")), this.options.connectTimeoutMs ?? 10_000);
    const signal = entry.controller.signal;
    try {
      const env: Record<string, string> = {};
      for (const [name, ref] of Object.entries(binding.envRef ?? {})) {
        if (!this.options.resolveCredential) throw new Error("mcp_credential_resolver_required");
        env[name] = await abortable(this.options.resolveCredential(entry.tenantId, ref), signal);
        if (!env[name]) throw new Error("mcp_credential_missing");
      }
      signal.throwIfAborted();
      const transport = entry.transport = binding.transport === "stdio"
        ? new StdioClientTransport({ command: binding.command!, args: binding.args, env, stderr: "ignore", maxBufferSize: this.options.maxResponseBytes ?? 2_097_152 })
        : new StreamableHTTPClientTransport(this.validateUrl(binding.url), {
          requestInit: { headers: env, redirect: "error" },
          fetch: async (url, init) => {
            this.validateUrl(url);
            const signals = [signal, init?.signal].filter((s): s is AbortSignal => Boolean(s));
            if (init?.method !== "GET") signals.push(AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000));
            const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
            return boundedResponse(response, this.options.maxResponseBytes ?? 2_097_152);
          },
        });
      await abortable(entry.client.connect(transport, { timeout: this.options.connectTimeoutMs ?? 10_000, signal }), signal);
      return entry.client;
    } finally { clearTimeout(timeout); }
  }

  private dispose(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing;
    this.retiring.add(entry);
    entry.closing = (async () => {
      // End stateful HTTP sessions as well as closing local sockets. Bound unresponsive peers.
      if (entry.transport instanceof StreamableHTTPClientTransport && !entry.controller.signal.aborted) {
        await bounded(entry.transport.terminateSession(), this.options.closeTimeoutMs ?? 1_000).catch(() => {});
      }
      entry.controller.abort(new Error(this.closed ? "mcp_pool_closed" : "mcp_connection_closed"));
      await bounded(entry.client.close(), this.options.closeTimeoutMs ?? 1_000).catch(() => {});
    })().finally(() => this.retiring.delete(entry));
    return entry.closing;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    const entries = [...new Set([...this.entries.values(), ...this.retiring])];
    this.entries.clear();
    await Promise.allSettled(entries.map(entry => this.dispose(entry)));
  }
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("mcp_operation_aborted"));
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("mcp_close_timeout")), timeoutMs);
  return abortable(operation, controller.signal).finally(() => clearTimeout(timer));
}

function boundedResponse(response: Response, limit: number): Response {
  if (!response.body) return response;
  if (Number(response.headers.get("content-length")) > limit) { void response.body.cancel(); throw new Error("mcp_response_too_large"); }
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error("mcp_response_too_large");
    controller.enqueue(chunk);
  } }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
