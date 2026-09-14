import { readFile } from "node:fs/promises";
import { join } from "node:path";

const STATE_PATH = join(process.cwd(), ".diy-trial", "state.json");
const input = process.argv.slice(2).join(" ").trim() || "你好";

const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as {
  dataPlaneUrl: string;
  sessionId: string;
  sessionToken: string;
};

const res = await fetch(`${state.dataPlaneUrl}/sessions/${state.sessionId}/turn`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${state.sessionToken}`,
    "Idempotency-Key": `chat-${Date.now()}`,
  },
  body: JSON.stringify({ input }),
});

const json = await res.json();
if (!res.ok) {
  console.error(json);
  process.exit(1);
}
console.log(json.output ?? JSON.stringify(json, null, 2));
