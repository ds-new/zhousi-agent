# 原生 Agent 运行与验收

## 环境、持久化与信任边界

生产配置、令牌前缀、Secret 清单、网络规则与备份要求见 [生产部署指南](production-deployment.md)。CP 使用 `DATABASE_URL`，客户 DP 使用独立的 `DIY_RUNTIME_DATABASE_URL` 并绑定唯一的 `DIY_TENANT_ID`。双向服务令牌按租户配置，平台管理令牌不进入客户 DP。CP 的 `DIY_TENANT_SERVICES` 初始可为 `{}`；此时数据库正常即可 ready，尚未登记的客户服务调用会明确失败。全局服务身份和不安全开发模式仅通过 `DIY_ALLOW_INSECURE_DEV=true` 显式启用。

`createStore()` 和直接构造 `PostgresStore` 都经过相同的持久化协调边界；直接构造后需先 `await store.init()`。CP 按租户隔离持久化与数据库锁，支持多个 CP 实例访问同一存储。启动迁移和 schema 冲突会明确报错，不静默切换到内存。`MemoryStore` 只适用于开发和测试。

每个 CP store 操作使用独立的业务状态；同租户排队，不同租户每实例最多 8 个操作并行。已知归属的请求定向加载租户，只读操作不生成写入前 checkpoint。评估 Trace 以客户 `eval_traces` 表为权威，独立查询和保留，不再复制到租户 JSON checkpoint；其他目录数据仍使用租户 checkpoint。冷实体查找、启动迁移和全局管理仍可能扫描目录。

目录写入在业务事务内比较加载时的原始 JSONB；若其他操作已改变 checkpoint，则报 `catalog_write_conflict` 并回滚本事务，避免平台锁连接断开后旧状态覆盖新状态。发布门禁读取最新证据与 Trace 写入还共用业务数据库的 Profile 事务锁。连接故障发生在提交应答附近时，调用者仍可能收到错误而数据库已提交；冲突保护不等同于所有 CP 接口支持自动重试，需先查询实际状态再决定下一步。

生产 DP 使用 `PostgresArtifacts` 保存 Session、Workspace Memory、归档、Skill、Vault 密文、审批、执行状态和用量 outbox。Session 作用域包含 tenant、workspace、session；同一 Session 的执行使用 PostgreSQL 事务级 advisory lock，其他副本竞争时返回 `session_busy`，不同 Session 可并发。锁连接失效会中止当前运行；进程退出后数据库自动释放锁。会话结果与对应状态更新在事务内提交，外部模型或工具的副作用不属于该数据库事务。

开发模式可使用 `LocalFiles`，通过 `DIY_DATA_DIRECTORY` 指定目录；文件按作用域 hash 命名、原子替换并限制权限。它不提供跨进程事务或分布式锁。生产不再依赖 DP PVC，也不再要求 DP 只能单副本；所有副本必须绑定同一客户、相同模型/目录配置和客户运行时数据库。

## 注册与执行接口

| 接口 | 身份 | 用途 |
|---|---|---|
| CP `POST /tenants` | 平台管理令牌 | 创建 schema 或 dedicated 租户 |
| CP `POST /api-keys` | 平台或本租户管理员 | 创建租户 API key |
| CP `POST /workspaces` | 租户管理员 | 创建 Workspace |
| CP `POST /profiles` | 对应 Workspace builder / 租户管理员 | 配置 prompt、modelRoute、skillIds、mcpBindings、kbConfig |
| CP `POST /golden-tasks` | 对应 Workspace 权限 | 创建任务及 `split: train / holdout`，包含非空评分断言 |
| CP `POST /profiles/:id/eval/run` | 对应 Workspace 权限 | `{tenantId,execute:true,versionId}`，真实执行后评分 |
| CP `POST /profiles/:id/multi-agent/eval` | 对应 Workspace 权限 | 按固定 Root/Worker 版本执行团队评估 |
| CP `POST /profiles/:id/pin` | 发布权限 | 发布通过证据门禁与必要审批的版本 |
| CP `POST /sessions` | 对应租户/Workspace 权限 | `{tenantId,profileId}`，取得 Session token |
| DP `POST /sessions/:id/turn` | 对应 `Bearer sess_...` | `{input}`，每个逻辑 turn 使用 `Idempotency-Key` |
| CP `POST /orchestration/run` | 对应 Workspace 权限 | 执行同 Workspace 的多 Agent 编排 |
| CP `POST /evolution/runs` | 对应 Workspace 权限 | 提案并实测候选 |
| CP `POST /tool-approvals/:approvalId` | 本租户管理员 | 批准或拒绝指定 turn 的工具调用 |
| CP `POST /sessions/recover` | 本租户管理员 | 人工解除已核查的不确定执行状态 |

内部 `DP POST /agent/run` 仅接受该客户的受信 CP 服务身份。Session token 由 CP 验证并解析固定 Profile 版本、工具目录和策略，客户端不能覆盖 tenant、快照或目录。Session 历史互相隔离，Workspace Memory 则在同 Workspace 的会话间共享；需要用户间保密时应使用不同 Workspace。

原生路径 `CP POST /sessions/resolve` 在一个 store 操作中校验 token、检查可选额度并返回固定版本、所绑定 Skill hash、当前 Workspace 策略与 MCP 目录。无效 token 不消耗 RPM。该合并仅在当前请求内生效，没有跨 turn 配置缓存；原生路径继续每轮获取当前策略。旧 DSH 插件的 Session bootstrap 缓存合同见 ADR-0002。

## 幂等、审批与中断恢复

生产客户端为每个逻辑 turn 生成唯一的 `Idempotency-Key`，允许 1–128 个字母、数字、下划线、点、冒号或连字符。网络重试使用原 key、原输入和原会话；新消息使用新 key。已完成请求返回保存的结果，相同 key 携带不同输入或版本会返回 `idempotency_conflict`。接口也兼容 JSON `requestId`，建议统一使用 header。

命中 `ask` 策略时，DP 返回 HTTP 202 和 `status: requires_approval`，同时保存工具名、参数、目录/Schema 指纹、快照、检查点与审批期限。客户端将 `approvalId` 交给有权限的租户管理员。管理员调用 CP 审批接口，请求包括 `profileId`、`sessionId`、原 `requestId` 和 `decision: allow / deny`。CP 从认证上下文取得 reviewer 身份并写入审计，不信任请求中自报的审批人。批准后客户端重发原 turn 和原幂等 key，从检查点恢复；审批过期、参数或工具绑定改变、快照改变均不能复用授权。默认审批期限为 15 分钟。

执行前会持久化意图。若进程崩溃、连接丢失或外部调用结果无法确认，重试会被 `execution_outcome_unknown` 阻断，系统不会自动重新执行可能已有副作用的工具。管理员应先核查外部系统与相关日志，再调用 CP `POST /sessions/recover`，提供 `profileId`、`sessionId`、`expectedRequestId`。恢复将原请求标记为 abandoned 并释放会话继续处理新请求；原 key 不能重放。恢复本身不会撤销外部操作，也不证明外部操作未发生。

## 用量投递与额度

正常执行及暂停审批产生的已提交用量事件保存在客户 PostgreSQL outbox。DP 在 turn 后尝试投递，并每 5 秒扫描重试；CP 按 `eventId` 去重计量，DP 仅在成功响应后删除事件，因此 CP 暂时不可用和重复投递不会丢失或重复累计已提交事件。事件包含计量、Profile 版本和工具元数据，不包含对话正文；它们不作为发布评估证据。

会话创建和新 turn 会检查 CP 当前额度，但没有执行前的跨副本 Token 硬预留。并发请求、计量投递延迟以及模型实际返回用量可能让额度超出阈值，因此当前为软额度控制。执行在用量提交前发生异常时仍可能产生供应商费用，需要按不确定执行记录与供应商账单核对；outbox 不能承诺所有外部费用的端到端 exactly-once。

## Workspace Memory 自治理

Memory 使用 tenant + workspace 作用域，与 Session 对话历史分别持久化。每次正常完成 turn 后原子更新 Memory；生产 DP 还每 60 秒启动一次有界维护，每轮最多扫描 20 个工件记录，通过 keyset 游标继续后续 Workspace。PostgreSQL 扫描只获取 key 与 scope，随后逐条治理；多副本维护通过存储更新锁协调。

默认活动记忆最多 1,000 项，TTL 为 90 天；归档保留期限为 30 天。活动 head 的完整 JSON 限制为 512 KiB，冷归档 JSON 为 4 MiB，包含条目元数据，超过限制会退休尾部条目或移除归档前部条目。这不是整个数据库大小配额。模型上下文按 updatedAt 选最新 20 条有效记忆，再限制为 16,000 字符；episodic 合并也按最新内容在前，避免截断最新事实。

去重采用同 kind 的完整内容 NFKC 与空白规范化比较；它不把相似但可能矛盾的事实自动合并。超过 50 条 episodic 条目时，将内容合并为 procedure，并保留原条目归档；这是保守的内容合并，不是已经通过业务验证的语义摘要或冲突裁决。活动 head 为 `workspace-memory` 的 `{format:2,entries}`，冷归档为 `workspace-memory-archive`。普通上下文与没有退休条目的追加不读写冷归档；维护在内容不变时不重写工件。旧内联归档和 legacy 工件在追加或维护时合并迁移；生产 adapter 中 head、archive、Session 和 outbox 在事务内提交，失败全部回滚。过期和容量淘汰意味着归档不是无限期备份。

## 自定义 model、Skill、MCP 与知识库

模型支持 OpenAI-compatible `/chat/completions`，例如：

```json
{"provider":"custom","model":"my-model","baseUrl":"https://model.example/v1","apiKeyRef":"vault://model-key"}
```

租户 gateway 需允许该 provider；客户运维把 `https://model.example` 放入逗号分隔的 `DIY_MODEL_ALLOWED_ORIGINS`。其他协议需 adapter。超时与 5xx 可尝试配置的 fallback，429 不通过 fallback 绕过限额。

凭据由客户域运维保存为 `encryptVault(secrets, deriveVaultKey(DIY_VAULT_KEY_MATERIAL, tenantId))` 密文，再通过实际客户 `ArtifactStore.write("vault", [tenantId], encryptedBlob)` 写入。生产使用已初始化的 `PostgresArtifacts`，开发可使用 `LocalFiles`；secrets 的 key 去掉 `vault://`。原生路径使用 `DIY_VAULT_KEY_MATERIAL`，旧 DSH 插件有独立 KMS 配置。当前没有最终用户凭据配置 UI。

通过客户内部令牌调用 `DP PUT /skills/content`，请求 `{tenantId,content}` 得到 `contentHash`；在 `CP POST /skills` 注册 `{tenantId,workspaceId,name,contentHash,source:"private"}`，再把 ID 放入 Profile 的 `skillIds`。运行时校验内容 hash 并加载 Markdown。Skill 是提示词能力包，脚本执行能力由批准的工具提供。

MCP 在 CP 目录注册并经本租户管理员批准，Profile 按 `serverName` 绑定。transport、command、args、url 和 envRef 来自批准目录，不能通过 Profile 换成其他凭据。HTTP 凭据作为 headers 使用；目标必须属于 `DIY_MCP_ALLOWED_ORIGINS`，重定向不被自动跟随。支持真实 stdio 和 Streamable HTTP，握手、工具调用、工具列表分页及响应大小均有边界；正常连接按租户/Workspace/Session 作用域复用，高敏连接限于 Session 且释放即关闭。

生产 stdio 默认禁用。显式启用前，客户必须建立独立容器或其他操作系统隔离；SDK 不提供恶意 MCP 沙箱。真实评估使用临时状态且只允许 `readonly` 工具与外部 KB，不能通过评估执行普通或高敏工具；`readonly` 是批准目录的受信声明，仍需工具服务端与网络权限保证没有写副作用。

KB 内容和检索在客户 DP。外部 KB 使用真实 MCP `tools/call`，默认工具 `search`，可配置 `searchTool`；参数为 `{query}`，返回 `structuredContent.hits` 或 text JSON `{hits:[{documentId,title,snippet,score}]}`。外部绑定也必须经该租户批准。

`kbConfig.retrievalMode` 默认为 `tool`：向模型提供 `kb_search({query})`，只有模型选择该工具才检索，并使用模型给出的查询。`auto` 在首次模型调用前检索一次并注入上下文。两种模式均执行 `kb_search` 策略：tool 模式支持持久化 ask 审批；auto 遇 ask/deny 直接拒绝，需人工审批的配置应选择 tool 模式。只有外部绑定被批准为 readonly 时，内外两源并发检索；normal/high 仍顺序执行。融合顺序和权重不变，任一源失败不会悄悄返回部分结果。

原生检索共享 turn 取消信号及 30 秒预算，贯穿 embedding、MCP 获取与调用；失败或取消会终止等待并释放资源。已经发送的 PostgreSQL 查询依赖数据库 statement timeout 终止，不承诺客户端信号可以撤回已提交的数据库工作。

内置 KB 支持受信的租户数据库路由；环境启动路径使用客户配置的 `DIY_DATABASE_URL` / `DIY_TENANT_DB_SCHEMA`，应与平台数据库分离。生产启用内置 KB 必须提供真实 embedding provider，通过 `DIY_EMBEDDING_BASE_URL`、`DIY_EMBEDDING_MODEL` 和客户 Vault 的 `DIY_EMBEDDING_API_KEY_REF` 配置。当前表为 `vector(128)`，输出维度/数值不符会失败，不能回退到开发 hash embedding；模型变更需要重新索引。建表与网络要求见 [生产部署指南](production-deployment.md)。

## 进化、评估与发布

`DIY_EVOLUTION_INTERVAL_MS` 默认关闭，设置如 `60000` 后启用周期。周期扫描已发布的 L0/L1 Profile，先真实测量，再对符合触发条件的低分 Profile 提案。周期与执行使用数据库分布式租约，存储同时拒绝同一 Profile 的并发活动进化；不再仅依赖单进程防重入。运行崩溃后可由运维核查并拒绝遗留活动运行，再重新发起。

自动进化要求至少 5 道 train 与 5 道独立 holdout，总计不超过 100，道题之间必须满足集合独立性要求。优化器只接触训练信息，候选按训练成绩选择，再比较基线与候选的保留集表现。发布需要当前任务集、当前快照、最新完整真实执行批次与门禁一致；普通 trace、模拟输出和优化服务自报提升不能替代证据。L2 变更仍需审批，失败不能替换原发布版本。

精确评分阈值、指纹与时效规则、保留集比较、团队版本清单、重放及恢复限制以 [评估与进化生产合同](evaluation-contract.md) 为准。侧车默认生成启发式候选，DSPy 可选；是否提高质量由 CP 的真实执行决定。测试中的模型 HTTP fixture 和本地 MCP 验证协议与隔离，不证明真实业务持续提升，也不能替代保留集轮换、真实模型成本/SLO 测量和业务复核。

## 部署验证状态

开发 Compose 配置解析、两份分域生产 Compose 的缺失配置拒绝检查，以及两个 Helm 图表的 lint/render 已通过。Helm 配置使用预建 Secret、PostgreSQL 持久化、健康/就绪探针和默认拒绝网络策略，不再要求 DP PVC。

本地镜像实构建在 Docker Hub 拉取 `node:22-alpine` 的认证请求阶段遇到网络超时，未进入应用构建；实际镜像启动、集群 rollout 与 CNI 流量阻断尚未验收。CI 保留镜像构建和数据库集成门禁，须在可访问镜像仓库的环境完成。详见 [生产部署与回退说明](production-deployment.md)。
