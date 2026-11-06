# 准备 Target Harness

`gear init --target dsh` 或 `gear init --target pi` 生成原生可编辑载体；项目中的 `target.path` 指向其资源目录。Target 与执行候选生成的 Meta profile 分别选择。

| Adapter | 可修改资源 |
| --- | --- |
| DSH | `preset/`、`plugins/`、`prompts/`、`skills/`、`workflows/` |
| Pi | `AGENTS.md`、`.pi/settings.json`、`.pi/extensions/`、`.pi/skills/`、`.pi/prompts/` |

DSH 的 `preset/agent.cordis.yml` 接线插件，固定 patch 配置 Skill 目录；一个未接线的提示文件不会自动生效。Pi 使用项目内原生发现规则；settings 不得重定向外部 packages/extensions/skills/prompts/themes。

容器评测由外层 Harbor 环境隔离。DSH 的固定容器 patch 使用 `danger-full-access` 和 `approval.policy: never`，Pi 使用原生自动批准模式；这些评测设置不写入宿主载体。真实 CLI、工具执行与独立评分的可重复验证见[容器测试说明](../../testing/target-headless.zh-CN.md)。

依赖清单、锁文件、Git 元数据和 manifest 不属于候选修改范围。core 检查资源边界，封存确切字节并验证运行身份。新增可编辑文件并不意味着可以修改上游 runtime 源码。

运行 Target 的具体版本、模型及容器由[profile](configuration.md)固定。每次 evaluate 使用封存候选，生成后不能直接编辑 `.gear/` 来改变它。

DSH 接线示例见[原生资源指南](../../../skills/refine/references/dsh-target-harness.md)。本机扩展加载、容器 materialization、模型是否采用策略是不同验证层次；当前结果见[实施记录](../../refactor-progress.zh-CN.md)。
