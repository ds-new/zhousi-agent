import { createServer } from "node:http";

const port = Number(process.env.DIY_MOCK_MODEL_PORT ?? 18999);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, provider: "mock" }));
    return;
  }
  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString()) as {
    messages?: Array<{ role: string; content: string }>;
  };
  const user = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
  const reply = user.trim()
    ? `试用助手：我已收到你的问题「${user.slice(0, 120)}」。这是本地 Mock 模型回复，说明 Control Plane → Data Plane → 模型链路已打通。`
    : "试用助手：你好，我是本地试用 Agent，随时可以继续对话。";

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    choices: [{ message: { role: "assistant", content: reply } }],
    usage: { total_tokens: 24 },
  }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-model listening on http://127.0.0.1:${port}`);
});
