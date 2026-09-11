# 企业智能体能力评估与整改记录

> 本文保留为上一轮历史记录。多副本状态、服务身份、审批、评估和部署已进一步整改，当前结论以 [生产评估报告](production-readiness-assessment.md) 为准。

日期：2026-09-10。范围：本仓库后端实现、HTTP 路由、数据库、运行时插件及测试；不是第三方框架源码审计或生产认证。

## 结论

整改前不能认定为满足要求的持续自进化 ToB Agent。虽然 96 项基线测试通过，但部分关键链路是占位实现：MCP 只有 Symbol 句柄、多 Agent 拼接字符串、默认评估从提示词寻找预期答案、进化侧车模拟提升，Postgres 对大多数业务状态没有重启恢复能力。测试通过与真实能力之间存在明显差距。

本次已补齐可执行后端闭环，并增加隔离、协议、恢复和评估真实性测试。当前可作为**受控客户域、单副本数据面的试点基础**。尚不能声称已达到大规模多租户生产就绪、持续泛化提升或与 QwenPaw/Hermes/Pi 完整等价。实际业务提升必须以用户提供的模型和独立业务评测证明。

## 逐项整改

| 用户要求 | 原有问题 | 本次落地 | 验收边界 |
|---|---|---|---|
| ToB 多租户 | 多处管理路由无统一鉴权，Workspace 参数可绕过归属 | 中央 admission、tenant/workspace/profile/run 归属检查、租户管理权限、启动默认鉴权；拒绝 unsigned OIDC 生产回退 | 全局 service token 属平台信任域；没有每客户 workload identity |
| Session 隔离 | token 缺少严格会话绑定；运行时上下文证据不足 | token 绑定 session/workspace/过期时间，DP 经 CP 验证，历史按 tenant/workspace/session 隔离，固定 Profile 版本 | 本地并发锁；多副本需分布式协调 |
| Memory 隔离 | 全局 workspace key，异步治理可能覆盖新内容 | tenant/workspace 双重命名空间，持久化活跃内容及归档，日期恢复、原子文件替换 | 同 Workspace 明确共享；不是用户私密 Memory |
| Memory 自治理 | 压缩丢原文、忽略阈值/容量、假异步成功 | TTL → 完整内容规范化去重 → 可恢复合并；全部类型容量限制；30 天归档，恢复及隔离测试 | 去重不是语义相似度模型；合并不是语义摘要；磁盘过期数据清理依赖后续治理/运维 |
| 数据库隔离 | 大量状态继承 MemoryStore，重启丢失 | schema/dedicated DB 路由，租户目录 checkpoint，恢复版本/会话/凭据引用/权限/评估等；全局锁避免并发覆盖 | 当前 checkpoint + 全局 advisory lock，非高吞吐设计；schema 共用应用数据库权限，非独立数据库角色 |
| 多 Agent 协作 | 虚拟 worker 与字符串占位 | 注入真实执行器；pipeline/supervisor/blackboard 传递实际输出；固定 worker 快照；同 Workspace；上限 32 | 当前是有限、顺序编排；无动态规划、并发调度或高级 supervisor 决策 |
| 快速 MCP | 未执行协议握手；key/限额有隔离缺陷 | 官方 SDK stdio/Streamable HTTP，连接并发合并、热复用、作用域隔离、10 秒握手限制、闲置释放、高敏关闭 | 实测为本地 stdio；真实远程服务器兼容性、OAuth 未验收；stdio 需可信目录与 OS 隔离 |
| 自定义 Skill | 主要只有目录元数据 | DP 内容寻址、SHA-256 完整性校验、租户内容存储；按 Profile skillIds 加载 | 当前执行 Markdown 指令；无完整脚本包沙箱与依赖安装器 |
| 知识库 | 外部 MCP 用普通 HTTP 模拟；内置 tenant key 不足 | 真正 tools/call search；内外融合；内部存储加 tenant/workspace 命名空间 | 内置 KB 数据库目标由 DP 配置；dedicated 场景使用单租户 DP |
| 自定义 model | 配置存在但缺真实推理链 | OpenAI-compatible 自定义 baseUrl/model，租户 provider 约束、DP origin 白名单、Vault key、有限 fallback | 无供应商真实 key 测试；非兼容协议需 adapter |
| 轻量 Agent | 缺少可测执行内核 | 有界 Node model/tool loop，8 轮、单轮 16 工具、128k 字符上下文、会话容量限制 | 指标不含模型推理/MCP 子进程 RSS；没有与 Pi 同条件基准 |
| Profile 评估 | 可能从预期答案构造输出，task/trace 不对齐 | 无执行器直接失败；实际输出带 taskId + evalBatchId；结果、延迟、工具成功和 tokens 门禁 | 当前是关键词评分；旧手工 trace 兼容路径仍按顺序评分，正式验收应使用 execute:true |
| 多 Agent 评估 | 指标工具缺乏真实团队执行证据 | 黄金任务驱动完整团队执行、记录参与/交接/成功率，持久化 scope=multi_agent 结果 | 协作分数是启发式指标；尚无 held-out 团队优化器 |
| 持续自进化 | Python 假 trace 与固定提升，候选可能未实测 | 可选定时周期；真实重测基线/每轮候选；累积 mutation、保留提升轮；发布前重测；无提升失败；L2 审批不可绕过 | 优化相同 golden tasks 存在过拟合风险；侧车默认启发式，非自动学得新能力的证明 |

## 独立复查发现并修复

1. Builder 携带 workspaceId 创建租户管理员 API key：403，合法 builder 创建 Profile 的对照测试仍通过。
2. URL 的外租户 workspace 被 body/query 的本租户 workspace 覆盖：冲突参数在写入前拒绝。
3. Evolution finalize/approve 接受其他租户候选版本：检查 candidate 的 Profile 归属及 run 已绑定候选；省略 candidate 的审批链也覆盖。
4. 生产鉴权接受开发 OIDC 字符串：默认关闭，且配置真实 verifier 时不得回退到开发 token。
5. Marketplace 重启后 publishedAt 为字符串导致排序异常：恢复 Date 并验证两项排序。
6. L2 待审批/已拒绝候选可直接 pin：Store 与发布入口均要求 approved，拒绝后同步版本状态。

## 验证证据

- 原有 TypeScript 基线：96/96。
- 最终 TypeScript：**140/140**，37 个 suite，0 失败、0 跳过；`npm test` 同时完成全部 workspace 构建。`npm run typecheck` 通过。
- Python：**4/4**；独立真实 PostgreSQL 集成：**3/3**。合计 **147 项测试通过**，包含本地 HTTP、MCP 子进程及临时 PostgreSQL；模型本身是确定性 fixture。
- PostgreSQL 在临时 Docker pgvector 数据库执行：schema 和 dedicated 路由恢复；12 次跨两个 Store 实例并发创建保持全部数据；API key、Session token、Skill、Profile 版本和 marketplace 日期排序恢复。
- `runtime-e2e.test.ts`：CP → DP → 本地模型 HTTP；Skill 内容进入请求、expectedContains 不进入请求；会话 token 交叉使用被拒绝；Session/Memory 落盘。
- `memory-archive.test.ts`：真实文件读写后恢复原文与日期，跨租户不可见，错误 Workspace 被拒绝。
- Compose 配置解析通过。Helm CLI 不可用，完整镜像构建与 Kubernetes 安装未验收。

本机 Node 22.23.1 / macOS arm64，一次基准：MCP 冷连接+listTools **106.52 ms**；30 次热复用 listTools 中位 **0.108 ms**、P95 **0.672 ms**；父进程 RSS **95.14 MiB**，相对测量前增加 **2.56 MiB**。来源 `npm run bench:runtime`，不含进程/import 启动、MCP 子进程内存及模型推理，不能视作生产 SLA 或比 Pi 更轻的结论。

## 与参考项目的关系

- QwenPaw 可参考其连接、工具和产品使用方式，但官方安全模型明确不把单实例作为互不信任的多租户边界；ToB 的鉴权和隔离必须另行实现。参见 [QwenPaw SECURITY.md](https://github.com/agentscope-ai/QwenPaw/blob/main/SECURITY.md)。
- Hermes 的演化方向是用评估优化 Skills、prompt 和代码。本工程借鉴候选—执行—评分—发布闭环，不能据此声称实现了其全部能力。参见 [Hermes self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution)。
- Pi 提供 agent loop 与工具包。本工程采取小型执行循环加可选插件的方式，但没有替换为 Pi，也没有进行等负载性能比较。参见 [Pi 官方仓库](https://github.com/earendil-works/pi)。
- MCP 连接使用 [官方 TypeScript SDK v1](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)。

## 生产验收仍需完成

真实模型与企业业务数据未提供，因此没有宣称业务收益。上线前需独立保留集和长期回归、每客户 DP/工具 OS 沙箱、分布式 Session/进化调度、数据库逐实体事务与租户角色、备份恢复和负载测试。普通 Session turn 尚未自动回传 CP trace/token 计量；当前持续周期依赖 golden tasks 主动探测，计费/配额闭环不能视作完备。policy=ask 会安全停止，但还没有人工批准后恢复执行的产品流程。

这些是明确的后续验收项，不能用本地 fixture 的通过替代。完整配置说明见 [运行指南](../operations/runtime.md)。
