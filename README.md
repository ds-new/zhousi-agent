# Zhousi Agent（DIY Agent Platform）

面向企业 ToB 场景的**多租户、可自进化智能体后端平台**。控制面（Control Plane）托管租户、版本、权限与评估；数据面（Data Plane）在客户域执行模型调用、MCP 工具、Skill、知识检索与记忆治理；Python 侧车服务负责生成进化候选。

> 仓库地址：[https://github.com/ds-new/zhousi-agent](https://github.com/ds-new/zhousi-agent)

## 核心特点

### 多租户与安全隔离

- **租户级数据库隔离**：支持 schema 或 dedicated 数据库两种模式，Session、Memory、Skill、Vault 均按 tenant/workspace 作用域隔离
- **双层身份体系**：平台管理令牌、租户 API Key、OIDC/JWKS 企业登录、双向服务令牌（CP ↔ DP）
- **Session 固定版本**：对话绑定不可变的 Profile 快照，客户端无法覆盖 tenant、工具目录或策略

### 可控的智能体运行时

- **有界执行循环**：最多 8 轮对话、每轮 16 工具调用、120 秒总预算，防止失控消耗
- **真实 MCP 协议**：支持 stdio 与 Streamable HTTP，连接池热复用、租户作用域隔离、响应大小与超时限制
- **工具人工审批**：高敏工具触发 `ask` 策略，持久化 checkpoint，跨副本恢复不重放已执行工具
- **幂等会话**：每个 turn 携带 `Idempotency-Key`，网络重试安全，已完成请求 7 天内可重放结果

### 记忆与知识

- **Workspace 级 Memory**：跨 Session 共享结构化记忆（fact / preference / procedure / episodic），TTL 清理、去重、容量上限与归档
- **混合知识库**：内置 pgvector 向量检索 + 外部 MCP KB 连接器，租户级物理路由
- **自定义 Skill**：Markdown 能力包，内容寻址存储，Profile 固定 skillIds 加载

### 评估、发布与自进化

- **Golden Task 评估**：至少 5 道 golden tasks，`{execute:true}` 真实执行后评分，通过证据门禁才能 pin 发布
- **多 Agent 协作**：Root/Worker pipeline、supervisor、blackboard 等有限编排模式
- **持续自进化**：Python 侧车（GEPA / DSPy）生成候选，独立 holdout 集门禁，L2 人工审批，严格提升才形成新版本
- **用量与配额**：已提交回合与 outbox 同事务，CP 按 eventId 去重计量

### 生产就绪

- Docker Compose（开发 / 生产）、Helm Chart、Network Policy
- PostgreSQL 事务锁、多副本 Session 竞争、优雅停机
- 214 项自动化测试（TypeScript + PostgreSQL 集成 + Python），详见[生产评估报告](docs/reports/production-readiness-assessment.md)

## 架构概览

```
Client ── tenant API key ──> Control Plane ──> tenant schema / dedicated DB
  │                              │
  │ session token                ├── evaluation → candidate → review/pin
  ▼                              │                    ▲
Data Plane <── internal token ────┘             Python Evolution Service
  ├── bounded model/tool loop → configured model endpoint
  ├── approved MCP → stdio / Streamable HTTP connection pool
  ├── tenant + workspace memory / session history
  └── customer-local Skill, encrypted vault, internal/external KB
```

| 组件 | 职责 | 默认端口 |
|------|------|----------|
| Control Plane | 租户/Workspace/Profile 管理、评估、发布、Session 签发 | 9878 |
| Data Plane | Agent 运行时、MCP、Memory、KB、Vault、工具审批 | 3080 |
| Evolution | GEPA/DSPy 候选生成、保留集门禁 | 9880 |

## 快速开始

### 环境要求

- Node.js ≥ 20（推荐 22）
- Python 3.10+
- PostgreSQL 16+（可选，开发可用内存模式；生产必需）
- Docker & Docker Compose（容器化部署）

### 1. 克隆与安装

```bash
git clone https://github.com/ds-new/zhousi-agent.git
cd zhousi-agent
npm ci --ignore-scripts
npm run build
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少设置以下令牌（生产环境请使用强随机值）：
# DIY_PLATFORM_ADMIN_KEY
# DIY_SERVICE_ACCOUNT_TOKEN
# DIY_DATA_PLANE_INTERNAL_TOKEN
# DIY_EVOLUTION_INTERNAL_TOKEN
# DIY_VAULT_KEY_MATERIAL
```

> npm 命令不会自动加载 `.env`，需通过进程环境注入；Docker Compose 会读取 `.env`。

### 3. Docker Compose 启动（推荐）

```bash
docker compose up --build
```

服务启动后：

- Control Plane：`http://127.0.0.1:9878`
- Data Plane：`http://127.0.0.1:3080`
- Evolution：`http://127.0.0.1:9880`

### 4. 本地开发模式

```bash
# 终端 1：Control Plane
npm run dev:control-plane

# 终端 2：Data Plane
npm run dev:data-plane

# 终端 3：Evolution 侧车
npm run dev:evolution
```

本地无鉴权开发需显式设置 `DIY_ALLOW_INSECURE_DEV=true`（**切勿用于暴露的服务器**）。

## 使用流程

完整 API 与恢复步骤见 [运行指南](docs/operations/runtime.md)，OpenAPI 规范见 [docs/openapi/](docs/openapi/)。

### 典型上线顺序

```
1. 创建租户          POST /tenants              （平台管理令牌）
2. 创建 API Key      POST /api-keys             （租户管理员）
3. 创建 Workspace    POST /workspaces
4. 配置 Profile      POST /profiles             （prompt、model、skills、MCP、KB）
5. 注册 Golden Tasks POST /golden-tasks         （至少 5 道，含评分断言）
6. 运行评估          POST /profiles/:id/eval/run  {execute:true}
7. 发布版本          POST /profiles/:id/pin
8. 创建 Session      POST /sessions
9. 对话 Turn         POST /sessions/:id/turn    （携带 Idempotency-Key）
```

### 配置自定义模型

```json
{
  "provider": "custom",
  "model": "my-model",
  "baseUrl": "https://model.example/v1",
  "apiKeyRef": "vault://model-key"
}
```

将 `https://model.example` 加入 `DIY_MODEL_ALLOWED_ORIGINS`，凭据通过 Vault 加密存储。

### 注册 Skill

```bash
# 1. 上传 Skill 内容到 Data Plane
PUT /skills/content  {tenantId, content}  → contentHash

# 2. 在 Control Plane 注册
POST /skills  {tenantId, workspaceId, name, contentHash, source:"private"}

# 3. 将 skillId 加入 Profile 的 skillIds
```

### 启用自动进化

默认关闭。配置真实模型与 golden tasks 后设置：

```bash
DIY_EVOLUTION_INTERVAL_MS=60000   # 每 60 秒扫描一次
```

要求：至少 5 道训练题 + 5 道独立 holdout 题，总计 ≤ 100 道。

## 测试

```bash
# 单元与集成测试（194 项）
npm test

# 类型检查
npm run typecheck

# Python 进化引擎测试
npm run test:python

# PostgreSQL 集成测试（需独立测试库及建库权限，会创建临时数据库/schema）
DIY_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/test_db npm run test:postgres
DIY_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/test_db npm run test:postgres:runtime
DIY_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/test_db npm run test:postgres:kb

# 运行时微基准
npm run bench:runtime

# 四项架构优化探针（本机 HTTP、Memory 字节量、只读 KB 并发）
npm run bench:architecture
```

## 生产部署

| 方式 | 文件 | 说明 |
|------|------|------|
| Docker Compose | `docker-compose.production.yml` | 客户独立数据库与密钥 |
| Helm | `helm/control-plane/`、`helm/data-plane/` | Kubernetes 部署，含 Network Policy |
| 客户数据面 | `docker-compose.customer.yml` | 仅部署 Data Plane |

详细步骤见 [生产部署指南](docs/operations/production-deployment.md)。

生产环境关键配置：

- Control Plane 使用 `DATABASE_URL`
- Data Plane 使用独立的 `DIY_RUNTIME_DATABASE_URL`，绑定唯一 `DIY_TENANT_ID`
- 双向服务令牌按租户配置（`DIY_TENANT_SERVICES`）
- Webhook 默认拒绝全部出站，需配置 `DIY_WEBHOOK_ALLOWED_ORIGINS`
- 生产 stdio MCP 默认禁用

## 项目结构

```
zhousi-agent/
├── services/
│   ├── control-plane/     # 控制面 HTTP 服务
│   ├── data-plane/        # 数据面 Agent 运行时
│   └── evolution/         # Python 进化侧车（GEPA / DSPy）
├── packages/
│   ├── auth/              # OIDC / API Key 鉴权
│   ├── db/                # PostgreSQL 持久化与租户路由
│   ├── domain/            # 领域模型
│   ├── kb-rag/            # 知识库 RAG 引擎
│   ├── orchestrator/      # 多 Agent 编排
│   ├── eval-harness/      # 评估框架
│   └── dsh-*-plugin/      # MCP、Memory、Vault、KB 等插件
├── helm/                  # Kubernetes Helm Charts
├── docs/
│   ├── operations/        # 运行与部署文档
│   ├── reports/           # 生产评估报告
│   └── openapi/           # API 规范
└── docker-compose*.yml    # 容器编排配置
```

## 文档索引

| 文档 | 内容 |
|------|------|
| [运行指南](docs/operations/runtime.md) | API 接口、幂等、审批、Memory 治理 |
| [生产部署](docs/operations/production-deployment.md) | 密钥、网络、备份要求 |
| [评估合同](docs/operations/evaluation-contract.md) | 评估与发布门禁细节 |
| [生产评估报告](docs/reports/production-readiness-assessment.md) | 逐项生产能力验收结果 |
| [平台规格](docs/specs/tob-agent-platform.md) | 原始需求与设计规格 |
| [CONTEXT.md](CONTEXT.md) | 领域术语与概念定义 |

## 许可证

本项目为私有仓库，使用前请联系维护者获取授权。
