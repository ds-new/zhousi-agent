import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CP = process.env.DIY_CONTROL_PLANE_URL ?? "http://127.0.0.1:9878";
const DP = process.env.DIY_DATA_PLANE_URL ?? "http://127.0.0.1:3080";
const DP_TOKEN = process.env.DIY_DATA_PLANE_INTERNAL_TOKEN ?? "local-dp-service-not-for-production";
const PLATFORM_ADMIN = process.env.DIY_PLATFORM_ADMIN_KEY ?? "";
const MOCK_ORIGIN = `http://127.0.0.1:${process.env.DIY_MOCK_MODEL_PORT ?? 18999}`;
const ROOT = process.cwd();
const STATE_PATH = join(ROOT, ".diy-trial", "state.json");

async function request(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json as Record<string, unknown>;
}

async function main() {
  await mkdir(join(ROOT, ".diy-trial"), { recursive: true });

  const tenant = await request(CP, "POST", "/tenants", {
    name: "local-trial",
    gateway: { allowedProviders: ["custom"] },
  }, PLATFORM_ADMIN ? { Authorization: `Bearer ${PLATFORM_ADMIN}` } : {});
  const tenantId = tenant.id as string;

  const workspace = await request(CP, "POST", "/workspaces", { tenantId, name: "demo" });
  const workspaceId = workspace.id as string;

  const skillContent = "# 试用 Skill\n你是 Zhousi Agent 试用助手，回答简洁友好。";
  const { contentHash } = await request(DP, "PUT", "/skills/content", { tenantId, content: skillContent }, {
    Authorization: `Bearer ${DP_TOKEN}`,
  }) as { contentHash: string };

  const skill = await request(CP, "POST", "/skills", {
    tenantId,
    workspaceId,
    name: "trial-skill",
    source: "private",
    contentHash,
  });

  const profileResult = await request(CP, "POST", "/profiles", {
    tenantId,
    workspaceId,
    name: "trial-agent",
    systemPrompt: "你是企业试用 Agent，请基于 Skill 内容回答。",
    skillIds: [skill.id],
    modelRoute: {
      provider: "custom",
      model: "mock-trial",
      baseUrl: `${MOCK_ORIGIN}/v1`,
    },
  });
  const profile = profileResult.profile as Record<string, unknown>;
  const version = profileResult.version as Record<string, unknown>;
  const profileId = profile.id as string;
  const versionId = version.id as string;

  for (let i = 0; i < 5; i++) {
    await request(CP, "POST", "/golden-tasks", {
      profileId,
      input: `试用任务 ${i + 1}`,
      expectedContains: ["试用助手"],
    });
  }

  const evaluation = await request(CP, "POST", `/profiles/${profileId}/eval/run`, {
    tenantId,
    versionId,
    execute: true,
  });
  console.log("评估通过:", (evaluation.gate as Record<string, unknown>).passed);

  await request(CP, "POST", `/profiles/${profileId}/pin`, { tenantId });
  const session = await request(CP, "POST", "/sessions", { tenantId, profileId });
  const sessionId = (session.session as Record<string, unknown>).id as string;
  const sessionToken = session.sessionToken as string;

  const turn = await request(
    DP,
    "POST",
    `/sessions/${sessionId}/turn`,
    { input: "你好，请介绍一下你自己。" },
    {
      Authorization: `Bearer ${sessionToken}`,
      "Idempotency-Key": `trial-${Date.now()}`,
    },
  );

  const state = {
    tenantId,
    workspaceId,
    profileId,
    sessionId,
    sessionToken,
    controlPlaneUrl: CP,
    dataPlaneUrl: DP,
    createdAt: new Date().toISOString(),
  };
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));

  console.log("\n=== 试用环境已就绪 ===");
  console.log(`Control Plane: ${CP}`);
  console.log(`Data Plane:    ${DP}`);
  console.log(`Session ID:    ${sessionId}`);
  console.log(`Agent 回复:    ${turn.output}`);
  console.log("\n继续对话:");
  console.log(`  node --import tsx scripts/chat.mts "你的问题"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
