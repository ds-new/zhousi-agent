# 生产部署与验证

本仓库提供控制域与客户域分开的部署配置。`docker-compose.yml` 仅用于本地开发：它显式启用 `DIY_ALLOW_INSECURE_DEV=true`、使用公开示例凭据，并共用测试数据库。生产部署使用下面的独立文件，不与开发文件合并。

| 配置 | 运行位置 | 内容 |
|---|---|---|
| `docker-compose.production.yml` | 平台控制域 | Control Plane、Evolution sidecar |
| `docker-compose.customer.yml` | 单个客户信任域 | 一个绑定 `DIY_TENANT_ID` 的 Data Plane |
| `helm/control-plane` | 控制域 Kubernetes | Control Plane Deployment、Service、NetworkPolicy |
| `helm/data-plane` | 客户 Kubernetes | Data Plane Deployment、Service、NetworkPolicy |

Evolution 镜像使用内置候选生成器；可选 DSPy 依赖未打包进默认镜像。候选是否改善由 Control Plane 的真实执行与评估决定，镜像健康检查不证明模型质量。

## 密钥与租户路由

生产令牌必须至少 32 个字符，各租户使用不同的令牌。平台管理员令牌必须以 `diy_pa_` 开头，客户访问 CP 的服务令牌必须以 `diy_sa_` 开头。可在安全终端生成，例如：

```sh
node -e "console.log('diy_pa_'+require('node:crypto').randomBytes(24).toString('hex'))"
node -e "console.log('diy_sa_'+require('node:crypto').randomBytes(24).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

将生成值保存在部署平台的 Secret/Vault 中。不要提交实际值、生产 `.env` 或渲染后的含敏感信息配置。

Control Plane 需要：

- `DATABASE_URL`：控制域 PostgreSQL；不填写客户运行时数据库。
- `DIY_PLATFORM_ADMIN_KEY`、`DIY_EVOLUTION_INTERNAL_TOKEN`。
- `DIY_TENANT_SERVICES`：受信的租户路由 JSON，首次开户前允许 `{}`。
- `DIY_EVOLUTION_URL`：私网 Evolution 服务地址。

可选 OIDC 需同时配置 `DIY_OIDC_ISSUER`、`DIY_OIDC_AUDIENCE` 与 `DIY_OIDC_JWKS_URL`；三者必须成组提供。远程 JWKS 用于验证签名，开发用的未签名身份文本不能用于生产。

开户后，将客户 DP 地址和双向独立令牌登记为：

```json
{
  "actual-tenant-id": {
    "dataPlaneUrl": "https://customer-agent.example.com",
    "dataPlaneToken": "replace-with-customer-dp-token",
    "controlPlaneToken": "diy_sa_replace-with-customer-callback-token"
  }
}
```

`DIY_TENANT_SERVICES={}` 表示尚未开户；CP 的 `/ready` 在数据库正常时仍可成功，而缺少客户服务路由的内部调用会明确返回不可用。

生产 Webhook 默认不允许任何出站目标。运维在 `DIY_WEBHOOK_ALLOWED_ORIGINS`（Helm 为 `env.webhookAllowedOrigins`）配置逗号分隔的准确 origin；投递禁止重定向和 URL 用户凭据，默认 5 秒超时，每次最多 32 项。该白名单不是网络层隔离，仍需限制出站流量；Webhook 是尽力通知，不替代持久用量 outbox 或 Profile 查询。

Data Plane 需要 `DIY_TENANT_ID`、`DIY_RUNTIME_DATABASE_URL`、`DIY_DATA_PLANE_INTERNAL_TOKEN`、`DIY_SERVICE_ACCOUNT_TOKEN`、`DIY_CONTROL_PLANE_URL`。其中 DP internal token 对应路由的 `dataPlaneToken`，service account token 对应 `controlPlaneToken`。数据库必须属于该客户，生产运行不依赖 PVC；Session、Memory、Skill、Vault 密文与待投递记录存储在客户 PostgreSQL。凭据解密还需要 `DIY_VAULT_KEY_MATERIAL`，密钥材料必须独立于数据库备份保管并可恢复。

普通会话的每个逻辑 turn 必须携带 `Idempotency-Key` HTTP header。网络重试使用同一 key；新的用户消息使用新 key，防止重复提交产生多份状态与 trace。

`DIY_MODEL_ALLOWED_ORIGINS` 与 `DIY_MCP_ALLOWED_ORIGINS` 配置允许的准确 origin（协议、主机和端口），格式以运行配置说明为准。生产 MCP stdio 默认关闭；仅在独立容器/虚拟机等操作系统隔离已经建立的客户部署中显式启用。MCP SDK 的 stdio launcher 本身不提供操作系统沙箱。

## 内置知识库

外部 MCP 知识库不需要本地 embedding 模型。启用内置 KB 时必须配置：

- `DIY_DATABASE_URL`：客户 KB 数据库，可与该客户的运行时数据库相同。
- `DIY_TENANT_DB_SCHEMA`：默认 `public`。
- `DIY_EMBEDDING_BASE_URL`、`DIY_EMBEDDING_MODEL`、`DIY_EMBEDDING_API_KEY_REF`；模型 origin 必须被允许，API key ref 在该客户 Vault 中解析。

由数据库管理员执行 [customer-kb-schema.sql](customer-kb-schema.sql) 创建默认 schema 中的表与 pgvector 扩展。非 `public` schema 部署应由管理员将脚本中的 schema 名固定替换后执行，禁止采用请求参数拼接 SQL。

数据库当前固定 `vector(128)`。Embedding 接口必须返回 128 个有限数值且向量非零；不支持指定 128 维的模型会明确失败，不进行静默截断或补零。生产模式不会悄悄回退到开发用 token hash embedding。切换 embedding 模型或其版本前必须重新索引全部文档，并用客户检索评估集确认召回与排序；维度相同不代表向量空间兼容。

## 容器与网络

镜像以 UID 1000 运行；Compose 与 Helm 设置只读根文件系统、去除 capabilities、禁止权限升级及有限临时目录。生产 Compose 对进程数、内存、CPU 设置上限，只将 CP/DP 端口绑定宿主回环地址。TLS、访问日志、请求速率限制和跨主机访问由受信的反向代理或网关提供。不要把 PostgreSQL、Evolution 或未鉴权的内部端点直接暴露到公网。

Helm 默认 `NetworkPolicy` 禁止所有入站与出站，仅允许 kube-system 中 kube-dns 的 DNS。安装前在 values 中明确增加业务入口、CP/DP 相互访问、PostgreSQL 与批准模型/MCP 目标的规则；否则 Pod 会因无法访问数据库而不能 ready。底层 CNI 必须实际支持 NetworkPolicy。[Kubernetes 官方说明](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

Kubernetes 原生 NetworkPolicy 按 IP/Pod/Namespace 约束，不能仅凭 hostname 防止 DNS rebinding。模型与 MCP 的应用 origin allowlist 还需要客户网络的 egress 代理/防火墙配合。Compose 的 network 分离也不等同于出站防火墙。

## 本地配置验证与交付门禁

```sh
docker compose -f docker-compose.yml config --quiet
node .github/scripts/check-deployment.mjs
helm lint helm/control-plane --strict --set authSecretName=existing-control-secret
helm lint helm/data-plane --strict --set authSecretName=existing-customer-secret,env.tenantId=actual-tenant-id,env.controlPlaneUrl=https://control.example.com
```

Control Helm Secret 必须包含 `DATABASE_URL`、`DIY_PLATFORM_ADMIN_KEY`、`DIY_EVOLUTION_INTERNAL_TOKEN`、`DIY_TENANT_SERVICES`。Data Helm Secret 必须包含 `DIY_RUNTIME_DATABASE_URL`、`DIY_DATA_PLANE_INTERNAL_TOKEN`、`DIY_SERVICE_ACCOUNT_TOKEN`，可选 `DIY_VAULT_KEY_MATERIAL`、`DIY_DATABASE_URL`。Charts 不生成密钥。生产应使用已审查的镜像 digest，Helm 支持 `image.digest`；Compose 要求明确提供 `DIY_CONTROL_PLANE_IMAGE`、`DIY_EVOLUTION_IMAGE` 或 `DIY_DATA_PLANE_IMAGE`。

CI 已配置锁文件安装、全量 TypeScript 测试与构建、类型检查、Python 测试、真实 PostgreSQL CP/DP/KB 集成测试、依赖审计、Compose 校验、Helm lint/render 与三个镜像的构建。CI 测试数据库仅在临时 runner 的回环地址使用 trust 认证，不需要也不接受生产凭据。仓库管理员仍需将 `Production quality gates / verify` 设为分支必需检查；工作流文件本身不能替代分支保护设置。

本次本地验证已通过 Compose 配置与失败关闭检查、两个 Helm 图表的 lint/render。官方 Helm 4.3.0 下载包依据发布页 SHA-256 校验。[Helm 官方发布](https://github.com/helm/helm/releases/tag/v4.3.0)

本次 Docker 镜像实构建在拉取 `node:22-alpine` 的 Docker Hub 认证请求阶段遇到网络超时，未进入应用构建。因此不能声称镜像启动、真实 Kubernetes rollout 或 NetworkPolicy 的实际流量阻断已验证。CI 已保留镜像构建门禁，需在可访问镜像仓库的环境完成。

## 上线与回退

先在预生产环境恢复一份脱敏数据库和 Vault 密钥材料，验证 `/health`、`/ready`、租户越权拒绝、会话恢复、正常对话的 trace 投递及 KB 检索。`/health` 检查进程存活，`/ready` 检查服务是否可接受流量；两者都不代表业务质量验收。对 Evolution 的自动周期先保持 `DIY_EVOLUTION_INTERVAL_MS=0`，待业务任务评估与审批路径通过后再按客户启用。

保留上一版本镜像 digest、版本配置和数据库备份。出现鉴权边界破坏、数据不一致或评估质量下降时先停止自动进化，恢复已批准的 Profile 版本并回退部署镜像。数据库迁移是否向后兼容必须在预生产验证；不要把回退镜像当成数据库恢复策略。备份至少覆盖控制域和每个客户域数据库，并定期演练恢复，核对 Session/Memory/Skill/KB 与令牌路由。上线后的 SLO、监控告警和容量阈值需由实际业务负载测试确定。
