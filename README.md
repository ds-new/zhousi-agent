# DIY Agent Platform

ToB 多租户自进化智能体平台 — 混合架构（Control Plane SaaS + 客户域 Data Plane）。

## 架构要点

- **Tenant** → 独立 DB schema
- **Workspace** → Session / Memory 命名空间
- **Agent Profile** → 可版本化配置（prompt、model、skill、MCP）
- **Runtime** → DeepSeek Harness + Cordis 插件
- **Evolution** → Python 侧车（GEPA/DSPy，Hermes 模式）
- **评估** → Profile 级 + 多 Agent 级（Phase 2）

详见 [docs/architecture/overview.md](./docs/architecture/overview.md) 与 [CONTEXT.md](./CONTEXT.md)。

## 包结构

```
packages/
  domain/              # 领域类型 + 路由/池化解析
  db/                    # Postgres / 内存 Store + 迁移
  dsh-tenant-plugin/     # 租户 Session meta 注入
  dsh-memory-plugin/     # L0 Memory TTL→去重→压缩
  dsh-mcp-pool-plugin/   # MCP 热连接池（workspace/session/tenant）
  eval-harness/          # Profile Pin Gate + 多 Agent 评估
  orchestrator/          # supervisor / pipeline / blackboard
  kb-rag/                # 混合 KB（内置 + 外部 MCP）
  dsh-orchestrator-plugin/
services/
  control-plane/         # 租户/Workspace/Profile/Session API (:9878)
  evolution/             # GEPA 进化侧车 (Python)
```

## API 示例

```bash
# 健康检查（storage: memory | postgres）
curl http://127.0.0.1:9878/health

# 创建租户（schema 隔离）
curl -X POST http://127.0.0.1:9878/tenants \
  -H 'Content-Type: application/json' \
  -d '{"name":"acme","isolationMode":"schema"}'

# 更新 Tenant Gateway（provider 白名单）
curl -X PUT http://127.0.0.1:9878/tenants/{tenantId}/gateway \
  -H 'Content-Type: application/json' \
  -d '{"allowedProviders":["deepseek","openai"],"rateLimitRpm":600}'

# 创建 Profile（需 tenantId + workspaceId；provider 受 gateway 约束）
curl -X POST http://127.0.0.1:9878/profiles \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"...","workspaceId":"...","modelRoute":{"provider":"deepseek","model":"deepseek-chat"}}'
```

Postgres 模式：设置 `DATABASE_URL` 后自动 schema-per-tenant 建库。

## Phase 2 API

```bash
# KB 文档入库 + 检索
curl -X POST http://127.0.0.1:9878/kb/documents \
  -H 'Content-Type: application/json' \
  -d '{"profileId":"...","title":"FAQ","content":"..."}'

curl -X POST http://127.0.0.1:9878/kb/search \
  -H 'Content-Type: application/json' \
  -d '{"profileId":"...","query":"关键词"}'

# 多 Agent 编排（默认 supervisor）
curl -X POST http://127.0.0.1:9878/orchestration/run \
  -H 'Content-Type: application/json' \
  -d '{"profileId":"...","goal":"任务描述","orchestration":{"topology":"pipeline"}}'

# 进化：手动 / 信号触发（passRate < 0.75 且 L1）
curl -X POST http://127.0.0.1:9878/evolution/runs \
  -H 'Content-Type: application/json' \
  -d '{"profileId":"...","tenantId":"..."}'

curl -X POST http://127.0.0.1:9878/evolution/runs/trigger \
  -H 'Content-Type: application/json' \
  -d '{"profileId":"...","tenantId":"...","passRate":0.5}'
```

## Data Plane 联调

```bash
npm run build
npm run dev:evolution          # :9880
npm run dev:control-plane      # :9878
npm run dev:data-plane         # headless DSH + 上述服务
```

## DSH 集成

```bash
# 安装 DeepSeek Harness 后，叠加本仓库插件
dsh --profile web --patch ./cordis.patch.yml
```

## 自进化分级

| Tier | 对象 | 策略 |
|------|------|------|
| L0 | Memory | 自动 TTL/去重/压缩 |
| L1 | Skill/MCP 描述 | 自动，可回滚 |
| L2 | Prompt/新 Skill/拓扑 | 人审 PR |
| L3 | 凭证/Access Policy | 禁止自动 |
