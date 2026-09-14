import type { KbSearchOptions } from "./types.js";

/** One deadline includes routing, embedding, connection startup and result collection. */
export async function runSearch<T>(options: KbSearchOptions, operation: (options: KbSearchOptions & { signal: AbortSignal }) => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("kb_search_budget_invalid");
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("kb_search_timeout")), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    return await observeCancellation(Promise.resolve().then(() => { signal.throwIfAborted(); return operation({ timeoutMs, signal }); }), signal);
  } catch (error) {
    // A failed branch aborts other work without mutating the caller's controller.
    controller.abort(error);
    throw error;
  } finally { clearTimeout(timer); }
}

/** Observe late completion/rejection even when an adapter cannot stop its underlying operation. */
export function observeCancellation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("kb_search_cancelled"));
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
