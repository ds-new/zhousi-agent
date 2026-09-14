# 四项架构优化实施

用户已选择全部四项并授权实施，保留本地试运行文件。按现有功能合同推进，不新增待确认的产品范围。

1. Workspace Memory：最终模型上下文选择最新记忆；active 与 archive 分存；在原 Session 事务中追加与归档；定时维护按 key 扫描，不读取全部 payload、不重写无变化记录；兼容迁移旧工件。
2. Session Bootstrap：一个存储操作完成 token 校验与执行资料组装；请求鉴权复用结果；不引入跨 turn 缓存，不改变现有原生路径的策略刷新语义。
3. Tenant 持久化：取消只读快照；隔离每次操作可变状态；已知 Tenant 定向恢复；Eval Trace SQL 权威存储与旧 checkpoint 迁移；保留审计、发布证据和锁。
4. Knowledge Base：tool 模式按需检索、auto 自动注入；只读双源有界并发，保持权重、失败、取消和权限语义。

先以失败测试固定缺陷；逐项验证后做全量构建、类型、HTTP、真实 PostgreSQL 回归与对比基准。外部模型质量与集群 SLO 不以本机数据替代。

职责：根线程负责 Memory、CP 请求接线及原生 KB 工具；数据库子任务负责 store；KB 子任务负责检索 adapter。所有代码留在工作区供审查，不包含用户试运行脚本。

实现与可复现探针已完成，见 [结果报告](../docs/reports/architecture-performance-implementation.md)。四项均保留对应行为回归；最终验证及运行边界汇总于生产评估报告。
