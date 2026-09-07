#!/usr/bin/env node
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: "string", default: process.env.DIY_CONTROL_PLANE_URL ?? "http://127.0.0.1:9878" },
    "api-key": { type: "string" },
    tenant: { type: "string" },
    name: { type: "string" },
  },
  allowPositionals: true,
});

const command = positionals[0];
const baseUrl = values.url!.replace(/\/$/, "");

async function request(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (values["api-key"]) headers.Authorization = `Bearer ${values["api-key"]}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(json);
    process.exit(1);
  }
  return json;
}

async function main() {
  switch (command) {
    case "tenant:create": {
      const result = await request("POST", "/tenants", {
        name: values.name ?? "cli-tenant",
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "api-key:create": {
      if (!values.tenant) throw new Error("--tenant required");
      const result = await request("POST", "/api-keys", {
        tenantId: values.tenant,
        name: values.name ?? "cli-key",
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "health": {
      const result = await request("GET", "/health");
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      console.log(`Usage: diy-agent <tenant:create|api-key:create|health> [--url] [--api-key] [--tenant] [--name]`);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
