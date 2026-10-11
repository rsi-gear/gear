# A1 tasks.consume 纯重算切片独立只读审查

结论：**本切片无阻塞性功能问题，可单独提交**。范围只含 createTasksConsumeProvider 的纯重算生命周期及其测试；tasks.select/publish 和未来 A1 host/evaluate workflow 不在本结论内。

证据：src/algorithm/providers/tasks.ts:45–84 从冻结的 taskViewRef/cursor/count 同步重算结果，不写 provider record；preflight/inspect/submit/collect 共用 check，先验证 schema、kind、implementationDigest、原 inputDigest、空计量及不启动预算时钟，再用 campaign grant 和签名 TaskViewAuthority.verify 授权。consumeTasks 检查 cursor 所属 view、索引和 count，返回有序 batch 与新 cursor（src/algorithm/data/tasks.ts:34–42,134–140）。inspect 返回 not-started，内核在此状态按原 envelope 执行 submit（src/algorithm/runtime/engine.ts:433–468），重放无新增物理副作用。CAS 内容缺件转为显式 source-artifact-missing 错误，不能产出假完成。新测试覆盖冷建 provider 丢回复、两候选独立 cursor、越权/身份漂移、错误 cursor、计量/时钟和缺件（tests/unit/algorithm-tasks-consume-pure.spec.ts:47–93）。

本轮未单独运行测试；主审转述实施者用 Python 3.11 + loopback 的相关 5 files/12 tests 及 typecheck 均通过。真实 A1 host 必须以 development/research 授权源装配 resolveGrant，本纯 provider 只消费已签名且被 grant 允许的 view，不替 host 决定用途；这是后续接线验收门，不阻挡此切片提交。

主审补充验证：schema 修复后独立运行 `algorithm-tasks-consume-pure.spec.ts` 与 `algorithm-data-providers.spec.ts`，2 文件 8 项通过。
