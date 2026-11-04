# 旧版本运行的实际恢复回归

`tests/integration/historical-resume.spec.ts` 接受 `GEAR_RECOVERY_BASELINE`，指向独立构建的旧版本包根目录（包含 `lib/cli.js`、`python/gear`、`assets` 及运行依赖）。也可通过 `GEAR_RECOVERY_LAYOUT_BASELINE` 追加另一个布局变更前的版本。均未设置时跳过，不把旧版本实现复制进当前发布包。

本地可以直接从工作区已有的历史提交构建，无需联网：

```sh
baseline_dir="$(mktemp -d /tmp/gear-recovery-baseline-XXXXXX)"
git archive 1f5c8e3f0f95516ee6bdbe1a0365b2451f2e0618 | tar -x -C "$baseline_dir"
ln -s "$PWD/node_modules" "$baseline_dir/node_modules"
node node_modules/typescript/bin/tsc -p "$baseline_dir/tsconfig.build.json"
GEAR_RECOVERY_BASELINE="$baseline_dir" npx --no-install vitest run tests/integration/historical-resume.spec.ts
```

该提交早于异步工作流；其 GEPA、RandomSearch 使用原来的阶段状态、五项操作握手和严格的旧版视图协议。测试实际调用其 `gear refine`，由真实的生产 Process profile 解析、外部进程执行器、冻结 Python worker、持久化 journal 和研究记录产生恢复状态，再调用当前 `gear resume`。执行器是确定性的本地测试进程，不发起模型请求或运行真实 benchmark。

若本地保留提交 `7721b78e00d61becff3ff2801760ba87a9be5ff3`，可以按同样方法另行构建，将目录传给 `GEAR_RECOVERY_LAYOUT_BASELINE`。该版本的 GEPA 已使用原生异步工作流，RandomSearch 仍是旧阶段实现；恢复测试兼顾两种冻结状态。这个提交尚未作为独立上游版本存在，CI 不获取它。CI 的完整回归只获取已存在于上游的 `1f5c8e3`，从确切提交构建基线并启用本测试。

每个版本的四种组合分别覆盖 GEPA、RandomSearch 的第二轮候选生成及候选评估：外部进程先持久化成功回执，再丢失响应。检查恢复通过 inspect 找回原回执，不重复已完成的生成或物理评估；冻结源码、已提交决策、旧请求和成功回执保持原样；累计预算和证据连续；两轮搜索的结果、决策、排名、成本与旧版本不停机运行一致；完成后再次恢复不产生额外工作。测试还保存旧 CLI 在恢复前查询的非空经验快照及任务详情，并核对新 CLI 的 query、read 和 archive。profile 身份通过正常握手计算，原目标、目标函数和算法身份均未重写。

跨版本 CLI 回归使用固定的外部 Process 执行器。对 `7721b78` 的身份输入还核对了源码。Hitch 针对 Pi 和 DSH 的 39 个实现输入在这次目录调整前后字节相同，实际运行还要满足原有环境和执行器身份。内置 Codex 和单次模型执行器把受信任的 Python 策略包也计入身份，目录调整会改变其指纹。用这些执行器启动的旧运行需要原来匹配的 Gear 和执行器环境。恢复命令会在执行前核对身份，已有回执和预算记录保留在原运行中。
