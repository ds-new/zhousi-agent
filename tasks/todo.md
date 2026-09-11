# 验收清单

上一轮能力基线与整改历史见 `docs/reports/agent-capability-assessment.md`，当前结果见 `docs/reports/production-readiness-assessment.md`。

- [x] 逐项核对用户要求与代码、测试、部署边界
- [x] CP 租户身份、JWKS、API key 撤销、客户服务令牌与 DP 固定租户
- [x] CP 租户持久化、同事务审计、并发及 dedicated DB 恢复
- [x] DP PostgreSQL 多副本 Session 锁、幂等、Workspace Memory 原子更新
- [x] 持久化 ask 审批、可信批准者审计、未知结果人工恢复
- [x] 用量 outbox 故障重投及 CP 去重计量
- [x] Memory 定时 TTL/去重/容量治理与冷数据清理
- [x] MCP 真实 HTTP/stdio 协议、连接复用、目录凭据约束和资源上限
- [x] KB 真实 embedding 接口与客户数据库路由
- [x] Profile/团队评估证据、train/holdout 进化、并发/重放发布门禁
- [x] Webhook origin 限制、无重定向、超时与投递上限
- [x] 配置失败关闭、健康/就绪、优雅关闭、容器约束、Compose/Helm/CI
- [x] 最终构建与类型检查；TypeScript 194/194、真实 PG 15/15、Python 5/5
- [x] 锁文件依赖审计 0 个已知漏洞；部署配置/Helm 验证；文档更新
- [ ] 真实模型、客户 MCP/IdP/KB 与独立业务测试集长期收益验收（无相应凭据/数据）
- [ ] 完整镜像构建与集群 rollout（镜像源认证网络超时；未连接集群）
- [ ] 目标环境负载、故障切换、网络阻断与备份恢复演练

现有合同不包含计费级硬 Token 预留、自动语义 Memory、独立租户 DB 账号或分布式团队调度；不能在产品描述中宣称已有这些能力。
