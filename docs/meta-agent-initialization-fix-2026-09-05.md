# Meta Agent 初始化失败：核验与修复

## 已确认的故障

Hitch 的平台探测对整个 stdout 做严格匹配，真实 Node preload 输出或 Harbor 合并进 stdout 的 stderr 可以使退出码为 0 的命令仍被拒绝。指定实验的 43 个 trial 都失败于该解析；原实验没有保存原始 stdout，因此不能断言当时是哪种输出造成的，也不能仅靠 artifact 元数据证明容器运行完全正常。

Meta 初始化另有独立阻塞：Gear 在 Agent 自己的工具 scope 安装候选文件系统工具，dsh-codex 0.2.6 又在同一个 scope 注册增强版 `read_image`。真实 AgentRegistry/AgentLoop 可以稳定复现同名注册异常，不需要假设事件重入或多个 installer。Gear 接受 partial baseline 后才创建 Meta checkpoint，所以本轮模型尚未收到第一轮请求。

回归还确认 ToolFs 的一个独立缺陷：图片工具嵌套 `inject(['attachments'])` 后，在隔离文件系统中不能访问 `fs`。关闭图片增强后仍然失败；只用 Cordis 隔离服务和嵌套 inject 也能复现。

## 修复归属

- **Hitch**：[PR #24](https://github.com/rsi-gear/agent-hitch/pull/24) 修改实际 Python 探测和两个回归测试文件。它从唯一机器标记读取平台与版本，拒绝非法/重复/缺失标记及非零退出，失败时保存限长诊断。基于 `dev` 的 `2321eb617c7fdb54f28e438b7c8ef4ab69fc1708`，修复提交为 `9c973d7c3189a1c26db1be3503737448e878deda`。
- **dsh-codex**：由独立 [0xsegfaulted/dsh-codex](https://github.com/0xsegfaulted/dsh-codex) fork 维护。`read_url_image(url)` 独立注册，原 `read_image(file_path)` 始终归文件系统工具所有。保留已有 `modifyReadImage` 设置键，它现在只控制 URL 工具。已有 URL 工具允许列表和提示词须同步使用新名字。这个插件不依赖 Gear，也不由 Gear 构建或发布。
- **Gear**：只在自己安装的 ToolFs 中补齐图片工具的 `fs` 注入。候选文件系统隔离和 Agent/preset 生命周期保持原有实现。

这里不增加 DSH registry API，不升级或覆盖全局 DSH 安装，也不靠关闭图片功能来解除阻塞。

## Gear 私有 ToolFs 安装物

`scripts/build-private-tool-fs.mjs` 在构建目录读取固定的 `@deepseek-ai/dsh-tool-fs@0.1.1-rc.2` npm 包并核对 SHA-512，严格匹配唯一的注入语句，再将 `attachments` 改为 `attachments, fs`。它使用 esbuild 生成 `assets/gear-tool-fs.js`，内联该工具使用的 diff 9；Gear 自身继续使用 diff 8。

所有 DSH 服务仍通过外部 imports 使用宿主实例。Gear 显式导入这个私有 asset；不改宿主 `node_modules`，不在运行时拦截注册，也不捆绑另一套 DSH core。安装包包含构建结果和上游许可证。只有源码开发/构建需要 npm、tar 和 esbuild；安装后的工具直接执行打包代码。

Gear 的 DSH 依赖范围显式接受 `0.1.0-rc.8` 和 `0.1.1-rc.2` 所在的兼容范围。原来的 `^0.1.0-rc.8` 按 npm prerelease 规则不接受 `0.1.1-rc.2`；仅假定它能复用现有宿主会导致干净安装冲突。开发依赖仍锁定 rc.8。

## 构建与安装

Gear 从本仓库独立构建：

```sh
npm ci
npm run typecheck
npm test
npm pack
dsh plugin --profile web add /absolute/path/to/dsh-plugin-refine-0.1.0.tgz
```

dsh-codex 从它自己的 fork 构建，按该仓库的 README 安装 `dsh-codex-0.2.6-fork.1.tgz`。不要用公共 npm 包的更新命令覆盖 fork 修订。两个项目分别安装，没有源码补丁或构建流程耦合。

## 验证与边界

Hitch 的 19 个 Python 回归和完整检查通过（454 passed / 5 skipped）；Linux、macOS、Windows 的 Node 22/24 六项 CI 全部通过。

dsh-codex 在公开 DSH rc.2 上通过完整 162 项测试、前后端类型检查和构建。回归验证 scope-local `read_image` 身份与 schema 不变、独立 URL 工具、配置开关、动态能力注册和真实 AgentLoop/checkpoint/fork/resume/dispose。

Gear 的 `tests/unit/private-tool-fs.spec.ts` 在 rc.8 和原版 rc.2 中验证两个隔离文件系统的真实 PNG 读取和普通文件编辑。还原注入修订后，该回归准确复现 `fs without inject`。tarball 在无开发依赖的 rc.2 环境中干净安装并运行通过，Gear 的 fs/tools/attachment/sandbox/llm/cordis 与宿主解析到相同实例；运行环境没有 esbuild 或 diff 构建别名依赖。干净源码安装后直接执行平台 sandbox 脚本，16 项通过、3 项按平台跳过。

Gear 完整回归：35 个测试文件通过、2 个跳过，340 项测试通过、8 项跳过；类型检查和构建通过。独立 Subagent 审查了两个最终实现与安装边界，未发现阻塞问题。审查发现的 fork 文档误装公共 npm 包问题已经修正。

## ECS 安装验证

2026-09-05 已在 ECS 安装上述三个修复包，保留原版 DSH `0.1.1-rc.2`。控制面使用独立 fork 的 `dsh-codex@0.2.6-fork.1`；Target 保留原有 `dsh-codex@0.2.6` 和 champion，以隔离本次初始化修复。

Hitch 的 controller runtime 要求包内有真实的 `node_modules/smol-toml` 目录。部署目录使用 npm 的 `install-strategy=nested`，并保留该 `.npmrc`，避免默认提升依赖导致 runtime payload 缺失。

首次准备失败还确认了原报告中的错误诊断问题：Hitch 返回 `failure_stage: preparing`、`trials: []`，并省略尚未生成的 dataset identity。Gear 曾将其误认作 partial evidence，把原始缺依赖错误覆盖为 dataset mismatch。现在只有非空 trials 可以走 partial evidence；空结果沿用原始失败路径，schema、eval ID、退出码和非空证据的 dataset 校验保持有效。85 个 evaluator 场景、类型检查、构建和四项 CI 已验证，独立 review 无阻塞。

实际验证使用 TB 2.1 的固定 10 个任务、并发 10、单次尝试，创建全新 evolution，避免复用旧 reservation。此次不执行候选晋级；独立实验的 `minimumCandidateScore: 2` 阻止额外 held-out 评估，不能据此判断候选性能是否达标。最终验收以这轮的 durable 结果为准。

主验证已完成：Hitch `status: succeeded`，10 个任务全部通过 container setup 并产生有效结果，6 个通过、4 个 verifier 未通过，0 个基础设施失败。运行时间为 2026-09-05 07:01:51.623 至 07:40:28.764 UTC。

| 任务 | Reward |
| --- | ---: |
| bn-fit-modify | 1 |
| build-cython-ext | 0 |
| build-pmars | 1 |
| build-pov-ray | 0 |
| caffe-cifar-10 | 1 |
| cancel-async-tasks | 0 |
| cobol-modernization | 1 |
| constraints-scheduling | 1 |
| custom-memory-heap-crash | 1 |
| db-wal-recovery | 0 |

- Evolution：`fcbe1fcc-9f8b-4853-ac5b-3485af5e509a`
- Round：`41468179-ce6e-48b9-855e-b5a14fbabd69`
- Baseline eval：`eval_8029842c5ca84dd7955b0954f2ffb75b`
- Controller runtime：`sha256:560ff8fe92593bd03c15e9b96f7fb827f5d74eeef7513fb03ac18e6843d2e901`

该轮随后成功创建 Meta 根会话、checkpoint、两个 generation attempt 和 fork session，不再出现同名工具注册错误。模型请求确实发出，但原有 `metaSampling.temperature: 1` 被提供方拒绝，原始错误为 `Unsupported parameter: temperature`。服务器配置已改为 `metaSampling: {}`；没有修改模型插件去静默丢弃用户参数，也没有改写旧 evolution 的冻结 spec。

为验证修正后的模型请求，另建单任务 Meta 冒烟实验，而非重跑整批长任务。该实验的 Meta generation attempt 成功，turn 1 以 `completed` 结束，耗时 52,968 ms，产生 6 条 assistant message、10 次 tool call/result，并完成候选 finalize，随后进入候选评估。实际请求为 `openai-codex/gpt-5.6-luna`，没有 temperature；18 个工具名无重复，`read_image` 与 `read_url_image` 各一个。

- Meta 冒烟 evolution：`dad10c92-91e6-4d16-ade0-982f52c2100c`
- Round：`5524ff1c-938e-4ede-9fcf-642f4370d0fd`
- Meta session：`c2f2e33f-6703-4fff-8ab4-9a71dc385d4a`
- 根 checkpoint session：`61cc8bb2-d73e-40dd-95b1-b8bd6c19bf7d`

主验证的 6/10 分数与该单任务冒烟实验分别记录，不合并为性能结论。

冒烟候选评估 `eval_0dac732deb3a4036bbb113d7e5ebc12a` 已结束：1 个有效 trial、reward 1、无基础设施错误。Round 的 `failure` 为空；终态 `rejected` 来自验收专用的晋级阈值 2，不是框架失败。验收后默认配置恢复为 10 个 seed 任务、并发 10、正常晋级阈值 0，保留 `metaSampling: {}` 和三个修复包；既有实验的冻结配置与结果保持原样。
