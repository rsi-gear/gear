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

服务器只做了只读核验，没有替换安装包、重启服务或重跑 43 个任务。生产验收仍需安装修复版本后确认 root checkpoint、generation attempt 和真实 Meta turn 出现；本地和 CI 通过不表示原实验已经重新运行成功。
