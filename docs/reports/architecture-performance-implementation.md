# 四项智能体架构与逻辑性能优化

日期：2026-09-12。基线：`26b27bf`。范围为用户选择的 Memory、Session Bootstrap、Tenant 持久化和知识库四项；代码留在工作区，未发布。

## 逐项结果

| 功能 | 原问题 | 已实现与验证 |
|---|---|---|
| Workspace Memory | 普通 turn 读取和重写整个归档；上下文可能选最旧 20 条，合并后截断最新事实 | `WorkspaceMemory` 封装热 head、冷 archive 与治理；选最新有效记忆，episodic 新内容在前；正常路径零冷归档读写；按元数据游标维护且无变化不重写；新旧归档合并去重、旧副本事实保留、完整 JSON 容量限制；真实 PG 验证 Session/Memory/outbox 原子回滚与重启 |
| Session Bootstrap | 带额度检查的解析请求跨 store 边界调用 7 次，重复验证和恢复租户目录 | 一个 `resolveSessionBootstrap` 返回执行资料；仅加载绑定 Skill hash；错误 Session token 拒绝且不扣 RPM；固定版本与当前策略保持原语义；真实 HTTP 验证只跨 store 边界一次，PG 验证一次租户 checkpoint 读取 |
| Tenant 持久化 | 全局实例队列与共享可变目录；只读也生成 before 快照；Trace 重复进入大 checkpoint | 每操作独立状态、同租户协调、不同租户最多 8 路并发；已知 Tenant 定向恢复；只读无 before 快照；Trace 独立 SQL 查询/保留/发布证据，迁移冲突拒绝覆盖；PG 验证跨租户阻塞隔离、重启、迁移和计量幂等 |
| Knowledge Base | 原生路径忽略 retrievalMode，每轮必检索；只读双源串行 | 默认 tool 模式提供 `kb_search`，由模型查询触发；auto 一次注入；使用批准目录、现有 policy 和 ask checkpoint；只读双源并发，保留融合权重/顺序，失败不吞；共享取消和超时，验证 HTTP MCP、embedding、审批恢复和跨租户 PG 路由 |

独立审查还检查了 Memory 迁移数据保全、序列化容量和截断边界，并发现真实运行时的小数 `latencyMs` 与 PostgreSQL INTEGER 列不兼容。该列改为 DOUBLE PRECISION，旧整型表迁移后同时保留历史整数和小数测量值。

故障注入另外复现了提交前平台锁连接丢失、另一副本读旧 checkpoint 并覆盖更新的时序。目录写入增加事务内原始 JSONB 比较，冲突使整个业务事务回滚；评估证据读写增加同 Profile、同业务数据库事务锁，避免只写 Trace 时绕过目录冲突检测。提交应答丢失仍可能使调用结果不确定，因此未承诺所有控制面写接口可以盲目重试。

## 可复现的本地性能证据

执行 `npm run bench:architecture`。环境为 Node 22.23.1、macOS ARM64；不访问客户模型或知识库。

| 探针 | 重建旧算法对照 | 当前实现 |
|---|---:|---:|
| Session resolve 外部 store 调用 | 改动前回归捕获 7 次 | 1 次，真实 loopback HTTP 200 |
| Memory 一次 context + append 冷归档读取 | 8,075,782 B | 0 B |
| Memory 同操作冷归档写入 | 4,037,891 B | 0 B |
| Memory 全部读取 / 写入 | 8,089,470 / 4,044,901 B | 13,688 / 7,010 B |
| Memory 15 次样本中位耗时 | 58.65 ms | 0.64 ms |
| 两个各 30 ms 的只读 KB adapter | 63.92 ms，最大同时执行数 1 | 32.16 ms，最大同时执行数 2 |

Memory 为 40 条活动记忆、1,000 条归档、没有退休条目的唯一事实追加；计时包含 JSON 字节统计，不包含初始化。旧算法为脚本显式重建的读/更新/治理对照，并非历史版本端到端运行。KB 为注入 adapter 的本地调度实验。上述时间不能解释为生产加速比、P95/P99 或与其他智能体的公平比较。

真实 PostgreSQL 测试另外验证：新增 100,000 字节 Trace 输出后，租户 checkpoint 内容 hash 不变；Trace 列表不恢复 checkpoint。一个 Tenant 被数据库锁阻塞时，同实例另一 Tenant 仍完成写入；8 Tenant、64 Profile 和 48 次重复计量请求回读无丢失、无串租户。这里是正确性与操作量证据，不是负载容量上限。

## 验证与剩余边界

完整测试记录在 [生产评估报告](production-readiness-assessment.md)。测试覆盖模型 HTTP fixture、真实 MCP 与一次性 PostgreSQL；不以模拟模型输出证明长期进化收益。

主要回归入口：

- Memory：[上下文与迁移](../../services/data-plane/test/workspace-memory.test.ts)、[真实工件事务](../../services/data-plane/test/postgres-artifacts.integration.ts)。
- Session：[HTTP store 调用边界](../../services/control-plane/test/session-bootstrap-hotpath.test.ts)、[Bootstrap 合同](../../packages/db/test/session-bootstrap.test.ts)。
- Tenant：[目录/Trace 集成](../../packages/db/test/catalog-architecture.integration.ts)、[丢锁与发布证据故障注入](../../packages/db/test/catalog-fencing.integration.ts)。
- KB：[原生 tool/auto/审批](../../services/data-plane/test/knowledge-tools.test.ts)、[双源并发与取消](../../packages/kb-rag/test/hybrid-concurrency.test.ts)。

这四项实现可进入受控预生产验收。仍保留租户 JSON 聚合、冷实体/全局目录扫描、单租户串行协调，以及 schema 共享数据库角色的边界。Memory 治理仍是确定性规则，KB 向量仍为 128 维；并发 KB 不会撤销已经发送的数据库查询。跨可用区故障、客户真实数据质量、生产 P95/P99 和长期自进化收益需要目标环境证据，未在本轮宣称通过。

升级前应阅读 [存储迁移说明](../operations/production-deployment.md#2026-09-12-存储布局升级)。
