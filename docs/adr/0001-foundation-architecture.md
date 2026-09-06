# ADR 0001: Foundation Architecture

## Status

Accepted

## Context

需要构建 ToB 多租户智能体平台，要求：Session/Memory 隔离、数据库级租户隔离、MCP/Skill 可扩展、模型可自定义、轻量 Agent 运行时、持续自进化、Profile 级与多 Agent 级评估。

候选基座：DeepSeek Harness (Cordis 插件)、Pi (轻量 agent-core)、QwenPaw (ToB Hub/Governance)、Hermes (GEPA 自进化)。

## Decision

1. **部署形态**：混合架构 — Control Plane 可 SaaS 化；Data Plane（Memory、KB、凭证、执行沙箱）留在客户域。
2. **Runtime 基座**：以 DeepSeek Harness + Cordis 插件体系为主；Pi 的 agent loop 设计作为内核参考；Hermes GEPA 作为独立 Evolution Service（Python 侧车），不耦合主 loop。
3. **隔离模型**：
   - Tenant → 独立 DB schema 或实例（硬隔离）
   - Workspace → Session + Memory 命名空间（同 Tenant DB 内软隔离）
   - Agent Profile → 配置与评估单元，不单独占 DB
4. **自进化分级**：L0 Memory 自治理自动；L1 Skill/MCP 描述微调自动可回滚；L2 Prompt/新 Skill/多 Agent 拓扑需人审；L3 凭证与 Access Policy 禁止自动变更。
5. **MVP 路径**：先交付租户可配 Profile + MCP 快连 + Session/Memory 隔离 + Profile 级评估；第二阶段接 KB RAG；多 Agent 协作与持续进化编排放 Phase 2。

## Consequences

- 主栈 TypeScript (Cordis/DSH)，Evolution Service 用 Python (DSPy/GEPA)。
- 需自研 Tenant/Workspace 数据模型与 DSH Session 插件的映射层。
- DSH 处于 developer preview，需封装适配层以吸收 breaking changes。
- QwenPaw 的 Governance/Access Policy 模型作为领域参考实现，非直接依赖。
