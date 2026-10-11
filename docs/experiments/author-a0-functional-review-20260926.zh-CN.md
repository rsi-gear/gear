# Gear Author A0 功能核心独立审计（最终）

审计对象：`/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear` 的 A0 最终冻结源码及已构建 `lib`，功能实现提交 `1025093`，方案基线 `9d5e684`。仅只读仓库；没有修改实现、提交或付费调用。本报告只评价 **A0 author functional core 是否可提交**，不等同于 A0 全部性能/历史门禁或 A1 作者体验通过。

**结论：可以提交 A0 functional core；当前没有已证实的阻断性功能问题。** 此结论建立在下面的真实 worker、Campaign journal 与 controller 冷恢复测试之上。此前发现的可捕获 SDK 错误、控制操作伪造、checkpoint 引用与源码闭包问题，在冻结源码中均有修复和针对性测试。性能门仍未通过，不能随功能核心一并宣称 A0 全量验收完成。

## 独立复测证据

- `vitest run tests/unit/algorithm-author-a0.spec.ts --maxWorkers=1`：**19/19 通过**，包含 TS 同步 workflow 错误、并行 pending sibling、unknown/丢回复、真实 controller SIGKILL、checkpoint/ref、纯控制、源码变化及 worker 时限。
- `/opt/homebrew/bin/python3.11 -m unittest discover -s packages/python-sdk/tests -p test_author.py -v`：**16/16 通过**，包含 Python 捕获重复 parallel 后不能发起 fallback、嵌套复合分支、float/intent 跨语言向量和真实 worker。首次默认沙箱运行的唯一失败是 `127.0.0.1` 监听 `EPERM`；按已授权的本机 loopback 权限重跑后全部通过，故不记作实现失败。执行时设置 `PYTHONDONTWRITEBYTECODE=1`。
- `vitest run tests/unit/algorithm-author-python-a0.spec.ts tests/unit/algorithm-author-python-kill.spec.ts --maxWorkers=1`：**5/5 通过**，其中真实 Python controller 在第二波 edit intent 已提交后被 `SIGKILL`，新进程按原 operationId/idempotencyKey 完成，角色不重提交，20 个 rollout 各计一次调用。此组同样使用已授权的本机 loopback 权限、`GEAR_TEST_PYTHON=/opt/homebrew/bin/python3.11` 与 `PYTHONDONTWRITEBYTECODE=1`。
- 我直接实例化 TS `AuthorProcessReplayPort` 与 Python `createPythonAuthorReplayPort`，比较所得 `hostDigest` 相等（本次均为 `a099b1535046d7dda8b45770ccf579263d6818a73643112e1956466756468e64`）。`identity.ts:32-50` 将相同 Gear host 树、Node 可执行文件/版本及 TypeScript 检查器字节纳入两端共同的 host 身份。Python 另封存项目/SDK、解释器及导入模块摘要（`python-port.ts:49-85`）。
- 主审另行报告 typecheck 通过、受影响 **8 文件/79 测试**通过、Python unittest **40 项（37 通过，3 项可选 Optuna skip）**通过，以及 npm 外部 consumer、wheel author import、既有跨语言 provider 的安装包脚本通过；这些是主审执行结果，非我的独立复测。

## 关键合同核对

1. **惰性复合与不可吞错误。** TS `index.ts:91-95,123-132,148-185,209-225` 以逻辑地址重放、逐波发布原子前沿，并在同步/异步 workflow 异常及非法 parallel 时设置 sticky fatal；作者 catch 后也不能提交 fallback。Python `author/__init__.py:39-45,436-476,564-581` 对 AuthorError 同样记录不可吞 fatal；正常业务 `OperationFailure` 仍可按 collect 合同处理。对应 TS 测试第 154–213 行、Python 测试第 123–189 行通过。`ignored=a; await b; await a` 仍是合法惰性用法；未将“waiting 时尚有未消费调用”误判成错误。
2. **冷重放与副作用边界。** 两语言真实 controller kill 测试均在已提交历史和下一组意图存在时强停，再以原 key 恢复；`runtime/engine.ts:580-612` 在整组操作终态前不调用 reduce，所以 `unknown` 不进入作者历史。TS/Python 源变更在新意图前拒绝；worker 每波新建，TS 有超时 `SIGKILL`，Python RPC 有超时/关闭。测试只证明这些具体断点与可计数假 provider，不推断任意外部 provider 已可靠。
3. **持久值与纯控制。** `adapter.ts:113-150` 在提交前校验 checkpoint 名称/schema/大小/引用图以及 observe/checkpoint 的绑定、预算、时钟选项；坏 `startsBudgetClock` JSON 型别也被拒绝。`providers.ts:45-68` 产出按逻辑步骤不可变的 OutputEntry；`graph.ts:8-26` 对重复 digest 的每个 ref 元数据先校验再去环。1 MiB history/reply、256 KiB checkpoint 超限会显式失败，不会静默绕过；分页和大数据分块仍未实现。
4. **安装暴露边界。** `package.json` 已导出 `rsi-gear/algorithm/author`，`files` 包含编译后 `lib`；`packages/python-sdk/pyproject.toml` 的包发现会包含 `gear_algorithm.author`。`scripts/check-algorithm-package.mjs:63-76,112-123` 从外部 npm 安装和干净 wheel import 验证两端入口，主审确认脚本通过。这只证明 **A0 SDK 入口可安装导入**，还不证明 A1 的外部作者能通过新 CLI/profile 驱动真实 Hitch 工作流。

## 尚未通过、不可混入功能结论的门禁

- **性能门：未通过。** `docs/experiments/author-a0-benchmark-report-20260926.json` 明确标记 Python wall/波阈值失败：复合轨迹约 **152.7 ms/F**、RHO 形轨迹约 **138.7 ms/F** 的额外耗时；RSS 最大值仅有抽样下界、尚未验证，产品默认 `maxFrontierWaves` 也未选定。报告的 Python SDK 摘要说明它由随后小修补重建，不能把这组数说成最终冻结源码已通过的性能验收。A0 性能结论需按冻结协议复测/优化并记录峰值；1000 波、10000 操作与长期耐久恢复属后续发布门。
- **历史兼容门：本审计未验收。** v4 第 374–386 行要求真实旧 Evolution/Refine 日志、训练记录/模型 manifest 和 Hitch 只读核验；本轮 author functional core 测试不能代替真实历史格式盘点或数据可用性证明。
- **A1+ 作者/依赖门：未完成。** A0 wire 第 37 行已说明 source checker 是已知不安全模式诊断，非任意 JS/Python 沙箱。TS 本地相对导入图已封闭（`source-check.ts:32-68`），但 bare npm 包及其 `node_modules` 字节不在 `identity.ts:13` 的 A0 源树摘要内；Python 封存版本与已加载模块，尚不等于任意延迟加载包的完整源码锁。安装包可导入不等于 RunSpec/CLI/profile、外部 provider、Hitch 和真实研究者用时门已通过。建议在 A1 安装与真实作者试用中明确冻结依赖和诊断边界。

没有发现需要在提交 **A0 functional core** 前再修的功能阻断。后续工作应继续保留上述性能、历史和 A1 门禁为未完成状态。

## 提交后的性能复测

功能审计不变。精确提交 `97e938f` 上的正式 1 次预热、3 次采样结果见 [独立报告](author-a0-benchmark-97e938f-20260926.json)：TS 两轨迹额外耗时为 82.43/76.33 ms/F，Python 为 125.15/114.09 ms/F。Python 仍未通过原 100 ms/F 门槛；冷恢复通过；峰值 RSS 上界仍未验证。此前失败报告保留，未放宽标准。
