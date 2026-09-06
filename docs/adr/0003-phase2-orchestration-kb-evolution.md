# ADR 0003: Phase 2 — Orchestration, KB, Evolution, DSH Deployment

## Status

Accepted

## Context

Phase 2 需确定：多 Agent 编排拓扑、知识库 RAG 接入、Evolution Run 触发机制、DSH 部署形态。

## Decision

1. **多 Agent 编排**：Profile 级可配置拓扑（supervisor / pipeline / blackboard），默认 supervisor + workers。
2. **知识库**：混合模式 — 内置 pgvector（tenant schema）+ 外部 KB MCP 连接器；外部只读 MCP 使用 tenant 级池。
3. **Evolution 触发**：手动发起 + 信号驱动（eval 通过率低于阈值触发 L1）；L2+ 仅手动且需人审。
4. **DSH 部署**：开发用 `cordis.patch.yml` overlay；生产 Data Plane 用 headless profile + 自研 HTTP 入口。

## Consequences

- AgentProfile 增加 `orchestrationTopology`、`kbConfig` 字段。
- Control Plane 增加 Evolution Run API 与 KB ingest/search API。
- Evolution Service 暴露 HTTP 侧车，供 Control Plane 调用。
- 新增 `scripts/run-data-plane.sh` 与 `cordis.headless.patch.yml`。
