# A1 `tasks.sample` provider 独立简审

结论：**当前独立 provider + A1 SDK 接口片段无剩余 functional blocker，可单独提交。** 本结论不覆盖真实 v2 host/profile/CLI、`tasks.consume` 新接线或科学测量。未修改仓库。

先前发现的直接合同矛盾已修：A1 SDK 过去会把有效 capabilities 的 `tasks.sample: {calls:2}` 放入 `limits`，但纯 sampling provider 禁止任何计费限额。现 TS/Python capabilities validator 拒绝 `tasks.sample` 的非空 limits；两语言 SDK 前沿固定 `limits:{}` 和 `startsBudgetClock:false`，37 个共享向量有负例；新增真实 SDK frontier → provider preflight/submit 集成测试。

Provider 从冻结输入、signed TaskView 与 profile grant 纯排序选取，不重复任务；子 TaskView 保留原 `TaskEntry` 的 purpose、exposure、ancestry，并记录 parentTaskViewDigest。preflight 拒绝未授权 experience、Task ID 范围外和任何 final-test 源视图；`authority.verify` 检查 MAC/CAS。cold reconstruction 的相同输入产生同一 CAS 引用，丢回复后 submit/collect 可重算；操作 identity、count/seed、profile maxCount 与空 limits 均检查。主审补查：实现者已将每个任务的排序 hash 预计算一次，排序规则保持不变。

独立验证：`algorithm-task-sampling`、A1 contract、真实 Python worker parity **3 files / 47 tests 全通过**；Python A1 **8/8 通过**。隔离 TypeScript typecheck（`/private/tmp/gear-a1-sampling-tsconfig.json`）通过。全仓 `npm run typecheck` 在并行未冻结的 `src/algorithm/author/run-resolver.ts:262` 报 `schema` 为 unknown；这是另一片段的在写文件，本轮不能把全仓类型检查记为通过，也不据此否定已冻结 sampling 片段。

后续真实 host 门禁：`resolveGrant(campaignId)` 与 TaskViewAuthority 的密钥/授权身份须来自冻结 profile/lock，恢复使用同一权限口径；当前 provider 若授权被撤销会 fail closed，而不伪造可恢复完成。这不影响同一冻结授权下的纯重算证明。
