# Gear 算法框架实施进度与审计

实施依据：[V3 实现方案](meta-agent-algorithm-implementation-plan-v3.zh-CN.md)。起点 `f715748dad576d3055e4a9eaab21b36015348aee`，分支 `codex/meta-agent-algorithm-plan`。实现由 GPT-6 Sol / xhigh 负责，主 agent 独立审计和提交。

## 阶段状态

| 阶段 | 状态 | 提交与验证 |
| --- | --- | --- |
| S0 方案/基线 | 已提交 `e5dfeb2` | V3、离线精确重建、source/build/parent/package 身份；6 文件 95 测试通过；重复捕获匹配，漂移期望拒绝 |
| S1 合同/内核 | 主审通过，阶段提交 | 最终 16 项内核测试；旧 search/identity 95 项；构建 typecheck 通过 |
| S2 Python/作者入口 | 主审中 | 持久 hook、实现闭包、准入检查、TS/Python 组件装配；尚未提交 |
| S3 历史/任务/执行 | 实现与主审修订中 | 历史授权、任务暴露、测量合同；物理 Hitch/角色桥尚未完成 |
| S4 非 GEPA recipes/Optuna | 未开始 | — |
| S5 训练接入 | 未开始 | — |
| S6 GEPA/包发布验证 | 未开始 | — |
| S7 真实运行/稳定性决定 | 未开始 | 无运行证据前 SDK 保持 experimental |

## S0 已确认的基线约束

- 旧 `src/search/identity.ts` 按固定源码/构建文件字节计算身份；新目录不在直接闭包。
- 默认 parent policy 还哈希整个 `package.json`。新增 exports/scripts 也会改变其身份；正式 manifest 修改必须与原 runtime 制品保留和恢复验证一起交付。
- 首批保持 `package.json`、lock 和旧 search/evolution 文件不变。新 CLI 先独立入口；正式包导出放到兼容阶段。
- worktree 的 `node_modules` 链接到原仓库已有依赖（被 git 忽略），两处原 manifest 相同；Node v26.5.1。
- 系统 Python 3.9 不满足原训练包要求；实现/测试选 `/opt/homebrew/bin/python3.11`（3.11.16）。新作者 SDK 保持轻量；训练包依赖单独处理。

## 报告规则

只登记实际执行的命令和结果；toy、CPU合同、仓库外安装、真实provider、GPU运行、科学效果分别记录。既有2026-09-10 GPU归档不认证新adapter。本文件初始版本没有新增测试通过或实现完成的声明。

## S0 验证记录

实现者在精确旧版快照执行六个 search 恢复/身份测试文件，95 tests passed；完整命令与首次离线构建失败的处置见 [基线说明](algorithm-baselines/f715748/README.md)。主 agent 独立比对当前 worktree 的全部旧 source/package/lock 闭包文件、临时基线 built 闭包与完整 tgz 摘要，均与 manifest 一致。capture 脚本仅允许新 output，并验证固定 ToolFs 输入；第二次独立捕获匹配，篡改 expected 明确拒绝。

原 checkout 的预存 lib 身份与本次精确 HEAD 重建不同；未将其冒充该基线，也未修改它。已将核验过的旧 tgz、ToolFs 输入和 manifest 保留在 worktree 被忽略的 `.evolve-lab/algorithm-baselines/f715748/`，供 S6 兼容路径使用；生成制品不进入源码 commit。其他历史 identity 仍须提供各自匹配制品。

## 训练改造前的补充基线

主 agent 在训练源码未修改时独立执行：

- `PATH=/private/tmp/gear-algorithm-training-test-env/bin:$PATH GEAR_TRAINING_TEST_PYTHON=/private/tmp/gear-algorithm-training-test-env/bin/python node node_modules/vitest/vitest.mjs run tests/unit/training --maxWorkers=2`：17 文件、127 项通过。首次沙箱执行有 23 项失败，原因是本机 `sysctl kern.boottime` 被拒绝；获准以本地测试权限重跑后全部通过。
- `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python /private/tmp/gear-algorithm-training-test-env/bin/python -m unittest discover -s python/tests -v`：180 项中 175 通过、3 项因未安装 CPU Torch 跳过、2 项本地 CPU inference fixture 启动超时；单独重跑两项仍失败。失败项为 `test_lost_start_reply_reconnect_and_idempotent_stop` 与 `test_supervisor_loss_retains_engine_ownership_until_recovery`，不是 GPU 验证。
- 独立临时环境：Python 3.11.16、psutil 7.2.2、aiohttp 3.14.3；Optuna 4.9.0 已成功安装，供 S4 真实库适配测试使用。未修改原 Python 环境，未安装 Torch/CUDA。
- 构建范围 `tsc -p tsconfig.build.json --noEmit` 曾通过；完整测试范围 typecheck 仍缺原依赖中的两个开发包声明：`@deepseek-ai/dsh-skill-filesystem` 和 `@deepseek-ai/dsh-tool-skill`。最终阶段验收另行记录。

## 主审确定的实施修订

- 预算回执支持 operation 作用域：provider 报告本操作累计用量，内核按 producer/source 与 operation 去重汇总。
- 本地持久操作在执行前记录 started；缺少完成回执时恢复为 unknown，不从缺失结果推断尚未执行。
- 当前 journal writer 由 Python 3 标准库 `fcntl` 持锁进程提交；锁持有者退出后旧调用不能写 HEAD。此为 POSIX 本地宿主依赖，作者说明和 CLI preflight 必须明确展示，尚不声称 Windows 支持。
- 内核和内置 provider 记录实际 source/build 文件闭包身份，不能仅靠同名版本常量恢复修改后的实现。

## S1 验收

主 agent 独立执行最终 `node node_modules/vitest/vitest.mjs run tests/unit/algorithm/kernel.spec.ts --maxWorkers=2`：16/16 通过；`node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit` 通过。此前同一工作树联合执行 15 项内核与 95 项旧 search/identity 测试，7 文件 110 项通过；之后仅修改新内核合同并重跑最终 16 项，未重复运行未改动的旧测试。

本阶段交付公开 JSON/schema/ref、artifact/binding、命名步骤、provider SPI/testkit 和持久内核。主审核对并补测：显式/默认绑定、不可变 slot、实际并行 dispatch、丢回包、started/unknown、锁持有进程死亡、同进程争抢、内容破坏、提供者及内核身份漂移、坏回执不污染其他完成结果、最终零用量、硬预算单操作限制和取消未释放。单 writer 的提交由持锁 helper 执行，提交回包不明立即终止该 tick，由下一次 load/inspect 恢复。

边界：仅 trusted-local；Python 3/fcntl 为 POSIX 宿主依赖。同步 helper 在副作用后没有完成记录时保持 unknown，需要外部确认；不提供任意程序的自动重复执行。stop 预算如实记录超额并阻止后续准入；hard 依赖 provider 的实际强制能力并拒绝越界回执。直接 API 调用者须提供全局唯一 campaignId，普通作者由 CLI 模板生成。公共 package exports 尚待 S6，与历史运行身份兼容同时交付。
