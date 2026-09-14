# 逐项生产能力评估与整改

更新：2026-09-12。范围：当前工作区后端及部署配置；本次四项架构优化基于 `26b27bf`，未提交、未发布到生产。架构按共享控制面、客户独立数据面、可部署多副本评估。

## 结论

上一轮版本未达到生产要求。本轮已补齐多副本状态一致性、租户服务身份、可靠计量投递、人工工具审批、独立保留集进化门禁及部署约束，并以真实 PostgreSQL、HTTP 和 MCP 测试验证关键路径。当前可进入受控预生产验收，不能把本地测试通过等同于所有功能已获生产认证。

2026-09-12 已完成 Memory 冷热分离、Session Bootstrap 聚合、Tenant 操作隔离与 Trace SQL 分离、KB 按需检索及只读并发，具体证据见 [四项优化报告](architecture-performance-implementation.md)。

下表的“合同通过”表示表中明确列出的行为已实现并通过测试；“条件通过”表示仍有业务或运行环境前提；“未通过”表示当前没有足够证据支持对应生产声明。测试使用模型 HTTP fixture，没有访问付费模型或客户真实知识库。

## 逐项结果

| 功能 | 结果 | 本轮修改与证据 | 保留条件或限制 |
|---|---|---|---|
| ToB 多租户身份和授权 | 合同通过 | CP 统一租户/Workspace/实体归属校验；每客户双向独立服务令牌；DP 固定租户；修复嵌套 payload 绕过；builder 管理权限负向测试 | 服务凭据由可信运维配置，尚非 mTLS/workload identity 自动轮转系统 |
| OIDC 与 API key | 合同通过 | HTTPS JWKS 签名、issuer/audience/时间声明校验与密钥轮换测试；开发 HS256 显式隔离；API key 可撤销且跨实例生效 | 需真实企业 IdP 验收；API key 前缀携带租户便于定向读取，旧格式兼容读取仍会扫描目录，宜轮换 |
| Session 隔离和恢复 | 合同通过 | tenant/workspace/session 作用域；快照版本固定；单 store 操作解析执行资料；PostgreSQL 会话事务锁；同请求幂等；双副本重放不再次调用模型；锁连接丢失取消执行并拒绝提交 | 已完成请求保留 7 天；网络失联后的外部副作用不能撤销，未知结果必须由管理员核查并恢复 |
| Memory 隔离 | 合同通过 | tenant/workspace 复合键；事务内原子更新；两个运行时并发处理同 Workspace 的 12 个 Session，无 Memory/用量丢失 | Workspace 内有意共享，不是用户级私密记忆；私密边界需独立 Workspace |
| Memory 自治理 | 条件通过 | 冷热分离；最新有效记忆进入上下文；TTL、去重、完整 JSON 容量限制；keyset 分批治理且不重写健康记录；旧工件迁移与原子回滚测试 | 当前为确定性治理，合并保留原文；没有语义矛盾消解、质量评分或模型生成摘要 |
| 控制面数据库隔离与原子性 | 条件通过 | schema/dedicated 路由；每操作独立状态、同租户协调、不同租户最多 8 路；只读免 before 快照；Trace SQL 权威与冲突校验迁移，保留发布门禁；回滚、重启及并发测试 | 其他目录仍是每租户 JSON checkpoint；冷实体查找/全局操作扫描目录，同租户仍串行；schema 共用应用数据库角色，不能替代独立凭据的数据库权限隔离 |
| 数据面数据库与多副本 | 合同通过 | 客户 PostgreSQL 存 Session/Memory/Skill/Vault 密文/审批/outbox；原子更新、缺行竞争、事务回滚及丢锁故障测试 | LocalFiles/MemoryArtifacts 仅用于开发；生产须绑定客户自己的数据库，尚未进行跨可用区故障切换与备份恢复演练 |
| 多 Agent 协作 | 条件通过 | 真实 Worker executor，固定快照，同 Workspace 校验，有界 pipeline/supervisor/blackboard 编排 | 当前为有限顺序编排；不是分布式 DAG 队列、动态并发规划或任意规模集群调度器 |
| MCP 快速连接与隔离 | 合同通过 | 官方 SDK stdio + Streamable HTTP 握手、认证、工具调用、关闭；并发连接合并、热复用；租户作用域与高敏 Session 冷连接；超时/取消/分页/容量/响应字节上限；批准目录决定地址与凭据引用 | 真实客户服务/OAuth 接入另验；连接额度为进程内；生产 stdio 默认关闭，启用须有 OS 隔离；网络策略应阻断 DNS 重绑定后的非授权目的地 |
| 自定义 Skill | 条件通过 | 客户域内容寻址存储、hash 完整性检查、Profile 固定 skillIds 加载；目录和内容按租户隔离 | 支持 Markdown 指令能力包；不包含任意脚本依赖安装与沙箱执行平台 |
| 知识库 | 条件通过 | 原生 tool/auto 语义与策略审批；只读双源并发、超时取消；真实 MCP/embedding；生产拒绝 hash 模拟回退；128 维校验；客户 PG 路由与跨租户检索/重启测试 | 向量维度固定 128；换模型须全量重索引；真实检索召回、文档生命周期和业务权限须客户数据验证 |
| 自定义 model | 条件通过 | OpenAI-compatible endpoint/model 配置、租户 provider 约束、origin 白名单、客户 Vault 凭据、有限超时/fallback、响应大小限制 | 其他模型协议需 adapter；模型实际能力、供应商限流和流式协议未用真实服务验收 |
| 轻量运行时 | 条件通过 | 有界 Node 循环：8 轮、每轮 16 工具、16 个并发执行、120 秒总预算；MCP/DB 资源回收、优雅关闭 | 本机微基准不含模型及子进程资源；没有与 Pi 同硬件、同模型、同任务对照，也未建立生产吞吐 SLO |
| 工具人工审批 | 合同通过 | ask 持久化 checkpoint，按 tenant/workspace/session/request/approval 精确绑定；批准快照、目录及参数不可换；过期/重复消费拒绝；跨副本恢复不重放先前工具；可信管理员身份与时间留痕 | 外部操作处于未知结果时禁止盲目重试；管理员需依据外部证据决定恢复，不能承诺跨系统 exactly-once |
| Profile 评估 | 合同通过 | 仅真实 executor 批次可发布；先存开始标记，校验任务集合/快照 hash、完整性、时效、有限数值；store 在 pin 事务重新校验；预期答案不发送 executor；评估 Memory 隔离，工具及外部 KB 限只读 | 默认关键词/延迟/工具成功率评分，不等于任意语义或安全性评分；须按业务定义有效任务 |
| 多 Agent 评估 | 条件通过 | 整队任务实际执行，保存每题结果和全部 Worker 版本；跨 Workspace 拒绝；历史结果持久化 | 交接与成功率是诊断指标，未实现团队结构的自动搜索，也未证明团队一定优于单体 |
| 持续自进化 | 条件通过；长期收益未通过 | 至少 5 train + 5 独立 holdout，总计 ≤100；保留集不发送提案器；严格提升且过门禁才能形成候选；分布式周期锁、终态防重放、旧基线拒绝覆盖；L2 审批；取消模拟成功 | 侧车默认启发式提案。5 道保留题只是下限，不提供统计显著性；重复使用保留集仍会适应，需轮换与最终测试集。真实长期泛化提升、A/B 和退化监控尚未验收 |
| 用量与配额 | 条件通过 | 已提交回合与 outbox 同事务；跨故障重投相同事件；CP 去重计量；不同金额复用事件 ID 返回冲突；暂停和最终分段计量不重复 | 额度为执行前软检查，没有并发 Token 硬预留；未知/失败外部调用可能需要补账；去重事件无自动保留期。不能宣称计费级严格预算上限 |
| Webhook 出站 | 条件通过 | 生产默认拒绝全部出站；运维配置准确 origin；禁止 URL 凭据/重定向，5 秒超时、最多 32 项、释放响应流；3 项回归通过 | 尽力通知，没有持久重试/签名投递合同；网络层出站隔离仍需落地 |
| 运维与交付 | 条件通过；部署验收未通过 | 生产配置缺失拒绝启动；health/ready 分离；超时、优雅停机、非 root/只读容器、网络策略；CI 构建/类型/测试/审计/Compose/Helm/镜像门禁 | 真实镜像构建被 Docker Hub 认证网络超时阻断；未进行集群 rollout、网络策略实测、告警接入、恢复演练与容量压测 |

## 实测证据

最终测试数量见文末验证记录。真实数据库使用临时、无卷 PostgreSQL 18 + pgvector，测试后销毁；没有访问生产数据。

主要测试入口：

- [控制面持久化与专库](../../packages/db/test/postgres-persistence.integration.ts)：租户隔离、原子性、并发与恢复。
- 运行时 `services/data-plane/test/postgres-artifacts.integration.ts`、`approval-postgres.integration.ts`：事务锁、两副本、并发 Memory、锁连接被终止、审批重放和恢复。
- 隔离 `services/control-plane/test/production-service-auth.test.ts`、`services/data-plane/test/production-http.test.ts`：服务身份、计量去重、批准者和请求包裹绕过。
- 评估 `services/control-plane/test/production-eval.test.ts`、`eval-integrity.test.ts`、`evolution-safety.test.ts`：伪造/旧/缺失证据、泄漏评分答案、保留集、失败和重放。
- 协议 `packages/dsh-mcp-pool-plugin/test/`、`packages/dsh-kb-plugin/test/postgres-routing.integration.ts`：真实 HTTP/stdio MCP 与知识库物理路由。

本地 `npm run bench:runtime`（Node 22.23.1、macOS ARM64）结果：Runtime 对象构造约 0.037 ms；MCP 冷连接加 listTools 93.71 ms；30 次热复用中位 0.115 ms，P95 0.666 ms；父进程 RSS 96.44 MiB、增量 3.52 MiB。此测量排除了 import/进程启动、MCP 子进程 RSS 和模型推理，不能推导生产 SLO 或优于 Pi。

## 仍不能关闭的生产验收项

1. 在目标客户模型、MCP、IdP 和知识库上，以代表性数据测量质量、检索召回、成本和 P95/P99，验证长期独立测试集收益；目前没有相应凭据与业务数据。
2. 在可拉取镜像的预生产环境跑完整 CI、镜像启动与 Kubernetes 发布，执行跨副本负载、数据库切换、网络隔离和备份恢复演练；当前未连接目标集群。
3. 明确业务需要 schema 逻辑隔离还是独立数据库凭据/实例隔离。当前 dedicated 库隔离不能自动等同于独立运维账号、独立主机或独立集群。
4. 若要求硬额度、严格账务对账、自动语义 Memory 或分布式团队调度，需要继续实现对应专门子系统；本轮没有把这些未实现能力描述为已有。

接口与恢复步骤见 [运行指南](../operations/runtime.md)，密钥和部署见 [生产部署](../operations/production-deployment.md)，门禁细节见 [评估合同](../operations/evaluation-contract.md)。上一轮 [能力报告](agent-capability-assessment.md) 保留为整改前后的历史记录，本报告覆盖其中陈旧的生产限制。

设计依据：事务内查询必须使用同一连接，见 [node-postgres 事务文档](https://node-postgres.com/features/transactions)；会话与事务 advisory lock 生命周期见 [PostgreSQL 锁文档](https://www.postgresql.org/docs/18/explicit-locking.html)。锁的存在不构成外部工具副作用可以回滚的证明。

## 2026-09-10 历史验证记录

| 验证 | 结果 |
|---|---|
| `npm test`（包含全工作区构建） | 194/194，37 suites，0 失败、0 跳过 |
| `npm run typecheck` | 全工作区通过 |
| `npm run test:python` | 5/5 |
| 真实 PostgreSQL：`test:postgres` / `test:postgres:runtime` / `test:postgres:kb` | 9/9、5/5、1/1，合计 15/15，0 跳过 |
| `npm audit --package-lock-only --audit-level=high` | 成功，0 个已知漏洞；普通本地树审计曾报接口 400，未把失败结果计为通过，CI 使用锁文件审计 |
| 生产 Compose 缺配置拒绝与安全配置检查 | 通过 |
| 两个 Helm Chart lint/render | 通过；Webhook 新配置合入后控制面再次通过 |
| `git diff --check` | 通过 |
| Docker 镜像实构建、远程 CI、集群安装、真实模型收益 | 未通过验收：镜像源访问超时；其余未执行，无相应证据 |

共 214 项测试通过（194 TypeScript + 15 PostgreSQL 集成 + 5 Python）；不同层面的重复行为验证不表示 214 项独立产品能力。

## 2026-09-12 四项优化验证记录

| 验证 | 结果 |
|---|---|
| `npm test`（含全工作区构建） | 217/217，37 suites，0 失败、0 跳过 |
| `npm run typecheck` | 全工作区通过 |
| `npm run test:python` | 5/5；HTTP 测试在允许本机监听的环境通过 |
| 真实 PostgreSQL：`test:postgres` / `test:postgres:runtime` / `test:postgres:kb` | 22/22、7/7、1/1，0 跳过；含小数延迟迁移与重启、schema/dedicated 丢锁冲突及审计回滚、市场目录首次写入、冷实体查找、发布证据事务锁 |
| `npm run bench:architecture` | Session 1 次 store 调用；Memory 普通路径 0 冷归档读写；只读 KB 双源并发断言通过 |
| `git diff --check` | 通过 |

本轮合计 252 项测试（217 TypeScript + 30 PostgreSQL + 5 Python）。未重复执行未改动的依赖审计、Helm 或镜像发布；历史验收记录不视为本轮重跑。仍未连接客户真实模型、生产数据库或目标集群。
