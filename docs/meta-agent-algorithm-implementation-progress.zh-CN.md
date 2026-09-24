# Gear 算法框架实施进度与审计

实施依据：[V3 实现方案](meta-agent-algorithm-implementation-plan-v3.zh-CN.md)。起点 `f715748dad576d3055e4a9eaab21b36015348aee`，分支 `codex/meta-agent-algorithm-plan`。实现由 GPT-6 Sol / xhigh 负责，主 agent 独立审计和提交。

## 阶段状态

| 阶段 | 状态 | 提交与验证 |
| --- | --- | --- |
| S0 方案/基线 | 审计通过，阶段提交 | V3、离线精确重建、source/build/parent/package 身份；6 文件 95 测试通过；重复捕获匹配，漂移期望拒绝 |
| S1 合同/内核 | 实现中，未审计 | 独立 agent；禁止触碰旧 search 闭包和 package manifest |
| S2 Python/作者入口 | 实现中，未审计 | 独立 agent，与 S1 对齐协议；先通过相对开发入口运行 |
| S3 历史/任务/执行 | 未开始 | — |
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
