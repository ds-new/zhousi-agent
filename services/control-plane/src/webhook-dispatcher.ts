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
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export async function dispatchWebhooks(
  store: ControlPlaneStore,
  tenantId: string,
  event: string,
  payload: Record<string, unknown>,
  fetchImpl: WebhookFetch = globalThis.fetch.bind(globalThis),
): Promise<WebhookDelivery[]> {
  const hooks = await store.listWebhooks(tenantId as TenantId);
  const matching = hooks.filter((hook) => hook.events.includes(event));
  const body = JSON.stringify({
    event,
    tenantId,
    payload,
    sentAt: new Date().toISOString(),
  });

  const deliveries: WebhookDelivery[] = [];
  await Promise.all(
    matching.map(async (hook) => {
      try {
        const res = await fetchImpl(hook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-DIY-Event": event,
          },
          body,
        });
        deliveries.push({ url: hook.url, event, ok: res.ok, status: res.status });
      } catch {
        deliveries.push({ url: hook.url, event, ok: false });
      }
    }),
  );
  return deliveries;
}
