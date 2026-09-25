# A1.2a run resolver 片段独立只读审查

结论：**已冻结的 resolver / shared manifest 校验片段无剩余阻塞性功能问题，可作为 A1.2a 骨架提交。** 此结论只覆盖 `run-resolver.ts` 的静态解析、注入式 read-only inspector 结果核验、lock candidate 与共享 kernel provider-manifest 规则；没有声称真实 profile service、CLI、Campaign run/resume 或外部 provider 已接通。

复核要点：

- 真实格式的身份分层已一致：Git commit/tree 用现有 exact OID 校验，Gear dataset/Harness manifest 用 `sha256:` 摘要；数字开头 task ID 与现有 compiled dataset 规则一致；Hitch `.bin` symlink 锁定 link、最终目标和目标字节（`run-resolver.ts:98–113,141–154,382–388`）。RunSpec/profile/roles、prompt、自定义 schema、runtime config、dataset manifest 和 Hitch 文件有有界读取及检查后重读，源树再摘要，inspector 期间变化会拒绝锁发布（`119–160,284–359,482–485`）。
- 固定 role 名仅为实例名，模板权限由 profile 限定；SDK alias 现在按模板与 input/result side 精确枚举，并与真实 role/workspace-edit provider 共用 schema factory。物理 inspector 自报的 schema 及其自洽摘要还要与可信 factory 规范字节相等；自定义文件按源字节与 schema 相等校验（`179–183,262–281,404–425`）。
- Profile 的易用 camel budget 字段在锁中显式映射为当前 provider/receipt 使用的 `model.requests`、`model.tokens`、`rollout.trials`；required provider 的 manifest、meter source、维度和 hard 能力一起验证。纯 kind（含 sample/consume/checkpoint/observe/measurement 和内置 derive）要求 trusted-local 且零计量，防止 check 通过后 SDK 发空 limits、kernel 拒绝预约（`362–365,426–479`）。共享 `validateProviderManifest` 同时被 resolver 与 kernel 使用，且提取文件进入 kernel identity 闭包（`runtime/provider-manifest.ts:4–21`、`runtime/engine.ts:109–113,152–158`、`runtime/identity.ts:6`）。
- 独立复测：`npm exec vitest run tests/unit/algorithm-author-run-resolver.spec.ts tests/unit/algorithm-kernel-validator-identity.spec.ts`，2 files / 7 tests 通过；实施者另报告 typecheck 与 resolver/kernel 25/25 通过。未调用外部模型或 Hitch；未修改 repo。

修复记录：本轮审查曾指出 (1) camel 预算维度与真实 provider dotted 维度不匹配；(2) 未知 SDK alias 可通过、自报宽松 schema 的 hash 可冒充内置 schema；(3) 纯 provider 可声明计量，造成 check→run 的空 limits 失败。上述三项在当前冻结源码和负例测试中已闭合。

**后续 A1 接线门（不阻挡本骨架提交）：** 正式 inspector 必须从真实 Git ref/manifest、完整 dataset 与逐任务内容、模型注册、Hitch capability/存储、运行环境和实际 `describe()` 生成 `AuthorPhysicalResolution`，不能把本测试 fixture 的自报 digest 当作证据。run/resume 应消费已发布 lock 并复核同一物理身份。当前 SDK alias 绑定的是现有 provider 的 operation/structured-result schema，其中 analyst operation schema较宽；高层 `ctx.role/ctx.propose` 作者输入到物理 envelope 的转换与业务字段约束仍须用真实 host/作者样例验收（作者合同 `docs/algorithm-author-sdk-authoring-v4.zh-CN.md:128,140–179`）。`explain` 当前是简要文字加完整 resolved 对象，最终 CLI 还需展示精确 Git 起点、编辑上限和预算单位等作者可核对字段。

主审另运行已有角色与 workspace-edit 回归，2 文件 28 项通过，验证共用 schema 提取未改变这两个 provider 的既有行为。
