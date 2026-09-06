# DIY Agent Platform

面向 ToB 的多租户智能体平台：租户可配置 Agent Profile，支持 Session/Memory 隔离、MCP/Skill 扩展、分级自进化与评估。

## Language

**Tenant**:
签约企业客户，拥有独立数据库边界与凭证域。
_Avoid_: Organization, Account, Customer

**Workspace**:
租户内的项目或团队空间；Session 与 Memory 的命名空间边界。
_Avoid_: Project, Team, Space

**Agent Profile**:
可版本化的智能体配置单元，包含 system prompt、模型路由、Skill 绑定与 MCP 连接策略。
_Avoid_: Agent, Bot, Assistant

**Session**:
一次对话线程，严格限定在单个 Workspace 内，不可跨 Workspace 共享上下文。
_Avoid_: Chat, Thread, Conversation

**Memory**:
跨 Session 持久化的结构化知识，受 Workspace 级自治理策略约束（压缩、去重、过期、归档）。
_Avoid_: Context, History, KB

**Evolution Run**:
一次由评估器驱动的配置变异批次（如 GEPA 优化 Skill 或 Prompt），产出候选版本而非直接覆盖生产配置。
_Avoid_: Training, Fine-tune, Learning

**Control Plane**:
平台运营侧：租户管理、Profile 版本、评估编排、进化调度、审计与计费。
_Avoid_: Admin, Backend, API

**Data Plane**:
客户域内：Session 存储、Memory、知识库向量索引、MCP 凭证与执行沙箱。
_Avoid_: Runtime, Worker, Edge

**Governance Tier**:
自进化变更的分级策略：L0 自动、L1 自动可回滚、L2 人审、L3 禁止自动变更。
_Avoid_: Permission Level, Risk Level

**Tenant Gateway**:
租户级模型与资源网关：限定可用 provider、配额、fallback 策略；Profile 的 modelRoute 必须落在网关允许范围内。
_Avoid_: Model Proxy, API Gateway

**MCP Pool Scope**:
MCP 热连接池的隔离粒度：workspace（默认）、session（高敏）、tenant（只读共享）。
_Avoid_: Connection Pool, MCP Tier

**Profile Pin Gate**:
Agent Profile 版本 pin 到生产前的评估门禁：通过率、延迟分位、工具成功率与成本上限。
_Avoid_: Release Check, QA Gate

**Skill Registry**:
Skill 来源与托管方式：公有 Marketplace 订阅 + 租户私有目录；私有 Skill 存 tenant schema，绑定 workspace。
_Avoid_: Plugin Store, Tool Catalog

**Isolation Mode**:
租户数据库隔离模式：schema（默认）或 dedicated（大客户/合规）。
_Avoid_: DB Tier, Tenant Level

**Orchestration Topology**:
多 Agent 协作拓扑模板：supervisor（主从分派，默认）、pipeline（链式传递）、blackboard（共享黑板）。
_Avoid_: Multi-Agent Pattern, Workflow

**Knowledge Base**:
Workspace 级检索知识源；内置 pgvector 索引与外部 KB MCP 可混合挂载。
_Avoid_: RAG Store, Vector DB, Corpus

**Evolution Trigger**:
进化批次的发起方式：manual（手动）、signal（eval 阈值触发 L1）、scheduled（定时 batch，Phase 2 末）。
_Avoid_: Auto-tune, Retrain Job
