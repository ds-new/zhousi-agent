# ADR 0002: Data Isolation and Runtime Policies

## Status

Accepted

## Context

Round 2 需确定：租户 DB 隔离粒度、MCP 连接池策略、Memory 自治理流水线、模型路由层级、Profile 发布 gate、Skill/MCP 自定义模式。

## Decision

1. **DB 隔离（混合）**：MVP 使用 schema-per-tenant；大客户/合规场景可升级为 dedicated instance。Workspace 在同一 tenant schema 内以 `workspace_id` 分区。
2. **MCP 池化**：默认 Workspace 级 warm pool；高敏 MCP 降级 Session 级；只读 KB 检索可 Tenant 级共享。
3. **Memory L0 流水线**：TTL → 去重（0.92）→ Compaction（>500 条），Compaction 异步不阻塞 turn。
4. **模型路由**：Tenant 网关（allowedProviders、quota、fallback）+ Profile 级 modelRoute 覆盖。
5. **Profile Pin Gate**：发布需 passRate ≥ 80% + P95 延迟达标；完整 gate（工具成功率、token 上限）Phase 1 末接入。
6. **Skill/MCP**：公有 Marketplace + 租户私有 Skill 目录；MCP 凭证存 Tenant vault，Profile 动态绑定。

## Consequences

- 需 platform schema 注册 tenant + 动态 CREATE SCHEMA。
- MCP pool key 须含 poolScope（tenant/workspace/session）。
- Control Plane 增加 TenantGateway 配置 API。
- eval-harness 增加 P95 与 pinProfileVersion gate。
