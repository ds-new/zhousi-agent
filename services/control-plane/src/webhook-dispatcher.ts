import type { ControlPlaneStore } from "@diy-agent/db";
import type { TenantId } from "@diy-agent/domain";

export interface WebhookDelivery {
  url: string;
  event: string;
  ok: boolean;
  status?: number;
}

export type WebhookFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: RequestRedirect },
) => Promise<Response>;

export interface WebhookDispatchOptions {
  /** Undefined permits development delivery; an empty array denies all outbound origins. */
  allowedOrigins?: string[];
  timeoutMs?: number;
  maxDeliveries?: number;
}

export async function dispatchWebhooks(
  store: ControlPlaneStore,
  tenantId: string,
  event: string,
  payload: Record<string, unknown>,
  fetchImpl: WebhookFetch = globalThis.fetch.bind(globalThis),
  options: WebhookDispatchOptions = {},
): Promise<WebhookDelivery[]> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const requestedLimit = options.maxDeliveries ?? 32;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("invalid_webhook_timeout");
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0) throw new Error("invalid_webhook_delivery_limit");
  const maxDeliveries = Math.min(requestedLimit, 32);
  const hooks = await store.listWebhooks(tenantId as TenantId);
  const matching = hooks.filter((hook) => hook.events.includes(event));
  const body = JSON.stringify({
    event,
    tenantId,
    payload,
    sentAt: new Date().toISOString(),
  });

  return Promise.all(
    matching.map(async (hook, index): Promise<WebhookDelivery> => {
      const failed: WebhookDelivery = { url: hook.url, event, ok: false };
      if (index >= maxDeliveries) return failed;
      try {
        const url = new URL(hook.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
            (options.allowedOrigins !== undefined && !options.allowedOrigins.includes(url.origin))) return failed;
        const res = await fetchImpl(hook.url, {
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            "X-DIY-Event": event,
          },
          body,
        });
        await res.body?.cancel().catch(() => {});
        return { url: hook.url, event, ok: res.ok, status: res.status };
      } catch {
        return failed;
      }
    }),
  );
}
