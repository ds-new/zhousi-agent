import type { IncomingMessage } from "node:http";

const bodies = new WeakMap<IncomingMessage, Promise<Record<string, unknown>>>();

export function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = bodies.get(req);
  if (!body) {
    body = (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 2 * 1024 * 1024) throw new Error("request_too_large");
        chunks.push(Buffer.from(chunk));
      }
      const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("invalid_body");
      return parsed as Record<string, unknown>;
    })();
    bodies.set(req, body);
  }
  return body;
}
