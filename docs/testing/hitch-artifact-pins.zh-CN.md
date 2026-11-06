# 执行前 Target 产物约束

Gear 要求 Hitch capability `evaluation_artifact_pins: "1"`，与[环境绑定](hitch-environment-binding.zh-CN.md)使用同一配套分支。该 Hitch 改动尚未发布，不能把已安装的 0.2.16 版本号当作支持证明。

Gear 在连接时按任务平台准备产物；每次物理提交只带当前任务组需要的平台、artifact ID、目录摘要和入口摘要。Hitch 规范化并持久保存请求，pins 进入幂等摘要，恢复与重试沿用原值。准备完成后以及实际 Harbor 调用前强制核对；Gear 接纳回执时还核对原请求中的 pins、计划、结果和 work item。依赖错配因此可在模型执行前拒绝，不能靠更新回执或重算 provider 身份绕过。

2026-10-12 的证据：

- Gear 相关四文件 96 项通过，另有多平台 artifact 六项通过；日志 `/tmp/gear-pins-regression.log`、`/tmp/gear-pins-platforms.log`。包含提交精确平台集合、daemon 依赖漂移不启动物理试验、恶意回包拒绝、历史基线复用边界。
- Hitch 四文件 75 项通过，日志 `/tmp/gear-hitch-pins-tests.log`。包括 schema、CLI、队列持久恢复、幂等冲突、准备阶段失败，以及每次 backend 调用前拒绝不同 ID、文件、入口或平台；多平台合法请求也经过实际执行路径。
- 入门流程 8 项通过（`/tmp/gear-pins-onboarding.log`），Hitch CLI 13 项通过（`/tmp/gear-hitch-pins-cli-final.log`）；CLI 首次回归暴露能力清单断言未更新，补入环境绑定和产物约束能力后通过。
- Gear 类型、lint、格式、边界与生成合同通过。Hitch 类型及 441 个源文件、950 条跨模块边的架构检查通过。
- 独立 npm/wheel 安装旅程通过，日志 `/tmp/gear-pins-package-final.log`；含 CLI/SDK、CPU training、取消恢复、OS 隔离算法、导入/评分，以及安装后真实 Hitch 探针。首次探针因自身临时父目录不存在失败，修正后重跑，不计首次为通过。
- 安装后的生产 provider 使用真实 ARM64 DSH/Pi 缓存验证：合法 pins 通过；错误 ID、目录摘要、入口摘要均在实际 Harbor 调用前拒绝，零 eval、零模型请求。报告 `/tmp/gear-pins-preflight-report.json`，原目录 `/var/folders/vr/wrfw08f92012yl64hzyb96br0000gn/T/gear-preflight-proof-hsZ8ix/`。

同一 `gpt-5.6-luna` 的正向验证：

| Target | Run | 结果 |
| --- | --- | --- |
| Pi | `run_a31b6155b6bd4710a2f0ef6d626daff0` | 单题 baseline 完成，1 条有效 0 分；同一冻结产物的 preview 可复用 1 个基线槽位 |
| DSH | `run_1cc2c7dd7beb4980a72bc6d25abca470` | 单题 baseline 完成，1 条有效 0 分；同一冻结产物的 preview 可复用 1 个基线槽位 |

这两个项目故意保留 `RESULT:` 前缀缺陷，因此 0 分是有效评分，不是环境失败。本轮只做产物约束的正向执行，没有重复完整优化；此前真实 GEPA 闭环的范围见 [Luna 验收](luna-live.zh-CN.md)及[环境绑定复验](hitch-environment-binding.zh-CN.md)。

两次 eval 的 request pins、准备产物和 work items 一致，controller runtime 为 `sha256:8968ee2ccc7b98eaccfb6c3080ec825962a098a526108e1baac7024b89d63a52`。证据 `/tmp/gear-pins-luna-proof.json`，完整报告位于 `/tmp/gear-pins-luna-pi-1/`、`/tmp/gear-pins-luna-dsh-1/`。115 个指定输出文件未发现原始访问令牌；该检查只覆盖 Gear 的 Hitch provider 目录及对应 Hitch eval 目录。两次 eval 无残留容器，自有 daemon 已结束。

复跑安装后的真实探针可设置 `GEAR_TEST_HITCH_PREFLIGHT=1`、`GEAR_TEST_ARTIFACT_CACHE`（无活动 daemon、无 eval 的自有缓存）和配套 `GEAR_TEST_HITCH`，执行 `node scripts/check-project-package.mjs`。单独运行 `node scripts/check-hitch-preflight.mjs` 可执行同一准备与错误 pins 探针。常规测试不调用计费模型。

本次关闭执行前 Target 产物约束缺口。Harbor Python 依赖及任意环境引用文件的完整证明仍属于 R1 未完成部分；没有将成功执行扩大为完整环境可重复性证明。README 未修改。
