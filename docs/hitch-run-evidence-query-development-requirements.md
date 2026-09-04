# Hitch Run Evidence 与语义轨迹查询开发需求

- 状态：Superseded；缩减后的 verifier evidence API 已在 Hitch `6351425` 实现
- 日期：2026-09-02

这份旧方案曾计划让 Hitch 同时负责 DSH 上下文重建、语义轨迹投影和 verifier evidence 查询。经代码核查后确认，这个职责划分过重：Hitch 已经提供 canonical DSH trajectory，而 Gear 已经具备直接消费 DSH surface 语义的条件。

请以新的实施方案为准：

[Meta Agent 轨迹重建与 Verifier Evidence 实施方案](meta-trajectory-reconstruction-and-verifier-evidence-implementation-plan.md)

新方案的边界是：

- Gear 读取并缓存 canonical DSH trajectory，负责内部语义投影和面向 Meta 的 compact diagnostic card；
- Hitch 继续负责证据持久化与完整性边界，只新增 structured verifier result 和 bounded diagnostics 的只读接口；
- Hitch 不生成 Meta Agent 专用的语义轨迹；
- server-side trajectory 索引仅作为后续性能优化。
