# Hitch 模型环境绑定

本页记录 Hitch capability `evaluation_environment_binding: "1"` 的实现与历史验证。Gear 当前要求 v3，包含 [v2 Python 内容身份](hitch-python-runtime.zh-CN.md)及 [v3 环境文件身份](hitch-environment-files.zh-CN.md)。单凭已发布的 Hitch `0.2.16` 版本号不能满足这一要求。配套改动位于同机独立 worktree `/Users/tangyehui/.codex/worktrees/gear-evaluation-binding/agent-hitch`，分支 `codex/gear-evaluation-binding`，基于 main `3ad5008acd77449fce67bec813994a51653e3cb5`；尚未发布。原始 Hitch checkout 未修改。

构建该 worktree 后，将 Target profile 的 executable 指向其 `dist/bin/hitch.js`，并由同一构建启动 profile root 对应的 daemon。Gear 通过 `eval bind` 准备实际驻留环境的绑定，再把绑定放入 provider 身份和每次提交的 `environment_binding`。绑定变化阻止跨 run baseline 复用。不要把 Gear CLI 自身的环境摘要作为 daemon 环境证明。

绑定使用 Hitch root 私有密钥的 HMAC，包含实际环境、模型、变量名及一次性取得的 helper 输出。公开结果只有 ID、模型、变量名和有效期。helper 凭据保留在 Hitch 私有记录，通过不可变 controller runtime 中的 host helper 沿私有通道交给 Target；不会刷新上游 helper，也不写入普通 Harbor 任务环境。新准入和实际 Harbor 启动均校验，缺失、改动和过期拒绝执行；幂等查询与取消保留原作业语义。

该协议限于 local-docker、外部模型、capture off/native，以及有限时评估。新运行需要至少覆盖 agent timeout 加 30 分钟 setup 的有效期；总和不超过 24 小时。它绑定环境值和 helper 输出，不证明任意被引用文件内容、Harbor Python 依赖闭包或执行前 artifact pin。

验证命令（分别在对应 worktree 运行）：

```sh
# Hitch
npm run build
npm run check:architecture
node --test --test-timeout=120000 dist/test/evaluation-binding.test.js dist/test/execution-observation.test.js dist/test/evals.test.js dist/test/ordered-eval-control.test.js

# Gear
GEAR_PYTHON="$PWD/.venv/bin/python" GEAR_TRAINING_TEST_PYTHON="$PWD/.venv/bin/python" npx vitest run tests/unit/project-hitch.spec.ts tests/unit/project-plan.spec.ts tests/unit/hitch-preparation.spec.ts tests/unit/hitch-sdk.spec.ts --maxWorkers=2
```

Gear 89 项通过（`/tmp/gear-binding-regression.log`），包括同一绑定的复用、绑定变化后的不复用、错误回执拒绝及提交前漂移拒绝。Hitch 74 项通过（`/tmp/gear-hitch-binding-test.log`），覆盖真实 CLI、驻留环境来源、helper 冻结和私有通道、缺失/损坏/失效拒绝、恢复、幂等与取消。Hitch 架构检查为 440 个源文件、947 条跨模块边；Gear 类型、lint、格式、121 个 TS 边界模块、151 个公开运行时模块和生成合同通过。

2026-10-12 使用新协议及同一 `gpt-5.6-luna` 运行：

| Target | 结果 | 本机证据 |
| --- | --- | --- |
| Pi | baseline + Python GEPA 一轮；复用 1 个历史槽位、新增 3 次实际评估；seed/held-out 均 0 → 1，gate accepted，4 个逻辑槽位全部有效 | `/tmp/gear-binding-luna-pi-3/refined-report.json` |
| DSH | 1 次真实 baseline，故意保留缺陷时得到有效 0 分；随后 preview 确认同一绑定可复用 1 个槽位、无新增基线试验 | `/tmp/gear-binding-luna-dsh-1/dsh-report.json`、`preview.json` |

Pi baseline 为 `run_2b52e667bb884b7f8369cebe6529d806`，refine 为 `run_f40bae877de34a6ca99f2b1d09b48e0e`；DSH 为 `run_3990d0b053604404949bc0f883af8c70`。五个实际 eval 均核对到各自冻结的绑定；controller runtime 为 `sha256:5a521781f5ff5eb15bf2343a672a04b38dca4413d432b09022d1c844a99b644b`。汇总见 `/tmp/gear-binding-luna-proof.json`。Gear 的 Hitch provider 目录及对应 Hitch eval 目录共 289 个受检文件没有原始访问令牌；这不代表检查了所有主机文件。五个 eval 均无残留容器，自有 daemon 已停止，见 `/tmp/gear-binding-luna-cleanup.json`。

前两次 Pi 尝试不计为通过：第一次新构建的 CLI 缺少可执行位；第二次绑定检查误拒绝原生 capture，已修正为允许 off/native、拒绝 proxy/hybrid，并完成取消。上述通过结果来自修正后的独立新 run。此前 [Luna 验收](luna-live.zh-CN.md) 中 DSH 的完整搜索结果仍保留为旧协议证据，本次 DSH 没有重复完整搜索。

独立 npm/wheel 旅程通过（`/tmp/gear-binding-package.log`），包含安装后的实际 daemon 绑定探针、只读 Hitch 条件检查、CLI/SDK、CPU training、取消恢复、OS 隔离算法及导入/评分合同。安装包探针没有调用模型。复跑环境探针时设置 `GEAR_TEST_HITCH` 指向配套构建，另设 `GEAR_TEST_HITCH_ENVIRONMENT=1 GEAR_TEST_HITCH_BINDING=1`；直接执行 `node scripts/check-hitch-environment.mjs` 也可验证同一协议。

本轮没有重复全量 TS/Python、Linux 或 GPU 验证；前次全量结果保持原有范围。环境绑定不是完整执行条件证明，R1 的 Harbor 依赖闭包与执行前 artifact pin 仍未关闭。README 未修改。

后续已补齐独立的执行前产物约束协议，当前状态及新增证据见[artifact pins 验证](hitch-artifact-pins.zh-CN.md)。上面的 run 与 runtime ID 保持本次环境绑定复验的历史范围。
