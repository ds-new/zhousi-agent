# DIY Agent Platform

面向 ToB 的多租户、可自进化智能体平台。控制面可托管，数据面（Memory、KB、凭证、Session）留在客户域。

## 租户与隔离

**Tenant**:
签约企业，拥有独立数据库边界（schema 或 dedicated 实例）。
_Avoid_: Organization, Account

**Workspace**:
租户内的项目或团队空间；Session 与 Memory 的命名空间边界。
_Avoid_: Project, Team

**Agent Profile**:
可版本化的智能体配置单元（prompt、model、skills、MCP、编排拓扑）。
_Avoid_: Agent, Bot

**Session**:
一次对话线程，严格限定在单个 Workspace 内，绑定固定的 Profile 版本。
_Avoid_: Chat, Thread

## 记忆与知识

**Memory**:
跨 Session 持久化的结构化条目（fact / preference / procedure / episodic），受 Workspace 级自治理策略约束。
_Avoid_: Context, History

**Knowledge Base**:
Workspace 级文档检索层，可混合内部向量索引与外部 MCP 连接器。
_Avoid_: RAG store, Vector DB

## 扩展与治理

**Skill**:
可挂载到 Profile 的能力模块；正文存 Data Plane，控制面只存 metadata 与 hash。
_Avoid_: Plugin, Tool pack

**Skill Catalog**:
Tenant 级 Skill 注册表；Workspace 可持有 private override。
_Avoid_: Skill library, Plugin store

**MCP Catalog**:
Tenant 级 MCP Server 连接模板；Profile 通过 serverName 引用并可选覆盖 sensitivity/poolScope。
_Avoid_: Tool registry, Integration hub

**MCP Binding**:
Profile 对 MCP Catalog 条目的引用与覆盖声明，含 sensitivity 与 poolScope。
_Avoid_: Tool connection

**Governance Tier**:
自进化与配置变更的分级策略——L0 全自动、L1 自动+审计、L2 人审、L3 禁止自动。
_Avoid_: Approval level, Risk tier

**Evolution Run**:
一次由评估信号或人工触发的配置变异批次，产出候选 Profile 版本。
_Avoid_: Training run, Fine-tune job

## 部署拓扑

**Control Plane**:
托管侧控制面，管理 Tenant/Profile 版本、评估编排、Evolution 调度；不存储 Memory/KB 原文。
_Avoid_: Admin API, Backend

**Data Plane**:
客户域内的 DSH runtime，执行 Session、Memory 治理、MCP 调用与 KB 检索。
_Avoid_: Worker, Runtime cluster

## 评估与协作

**Profile Pin Gate**:
Profile 版本发布前的质量门禁（默认：passRate ≥ 0.85、P95 ≤ 8000ms、toolSuccessRate ≥ 0.90）。
_Avoid_: Quality check, Release gate

**Golden Task**:
租户为 Profile 提供的基准评估用例（MVP 要求 ≥ 5 条），用于 Pin Gate 与 Evolution 信号。
_Avoid_: Test case, Benchmark prompt

**Orchestration Topology**:
多 Agent 协作模式——supervisor（调度）、pipeline（流水线）、blackboard（黑板）。
_Avoid_: Multi-agent pattern, Workflow type

## 连接与安全

**MCP Pool Scope**:
MCP 热连接池的复用边界，由 sensitivity 驱动——readonly→tenant、normal→workspace、high→session。
_Avoid_: Connection pool tier, MCP isolation level

**Credential Ref**:
指向凭证 vault 中密钥的间接引用（如 `vault://tenant/{id}/mcp/github`），Profile 中不存明文。
_Avoid_: API key, Secret string

**Access Policy**:
租户级能力调用策略，按 allow/deny/ask 三效评估 MCP 与工具调用；默认 deny-by-default for high writes。
_Avoid_: Permission rule, RBAC policy

**Eval Trace**:
单次 Agent 执行的完整记录（output、latency、toolCalls、tokens），供 Pin Gate 与 GEPA 进化使用。
_Avoid_: Log, Span

**Profile Sync**:
Control Plane 将 pinned Profile 版本分发至 Data Plane 的机制（pull / push / webhook）。
_Avoid_: Config deploy, Version rollout
