# 旧 RHO、AHE、Evo recipe 的物理宿主回归

本目录保留内部 initialize/reduce recipe 的装配与对照夹具。新算法使用[显式状态作者 API](../../../docs/algorithm-authoring.zh-CN.md)和[共用物理 host](../step-search/README.md#物理执行)，不按 recipe 名称配置能力。

普通作者只选择一份 Python recipe 并调整科学参数。**宿主管理员**一次性建立受限 DSH 模型目的地、编译器、Hitch daemon、Git Harness、数据授权与预算。`createConfiguredFreshHostProfile` 从闭合的 `host.settings.json` 构建 `execution.role`、`execution.feedback`、`execution.rollout`、必要的 `execution.workspace-edit`、任务和证据 provider；它不是让 recipe 从输入里选择文件或授予权限的捷径。

在 Campaign 配置目录中，宿主入口 `host.mjs` 可以保持为两个静态公开导入：

```js
import { createConfiguredFreshHostProfile } from 'rsi-gear/algorithm/harness';
import { registerModel } from './model.mjs';

export const hostProfile = {
  create(context) {
    return createConfiguredFreshHostProfile(context, {
      settingsPath: './host.settings.json',
      registerModel,
    });
  },
};
```

`gear.algorithm.json` 的 `hostProfile` 条目指向 `{"language":"typescript","module":"./host.mjs","export":"hostProfile"}`，`algorithm` 条目仍单独指向 `gear_algorithm.recipes.rho`、`.ahe` 或 `.evo` 的 `algorithm`。不要在宿主模块再实现一份科学状态机。`model.mjs` 必须提供**真实** `registerModel(llm)`：它在传入的 DSH runtime 中注册目标 provider/adapter，并返回 `{destinationId, currentDestinationId}`；工厂会检查所报目的地、实际已注册 provider 和可解析的模型。只返回匹配字符串而未注册 adapter 会失败。当前 loader 允许正常模块导入；源码和声明的 runtimeResources 参与运行身份，管理员负责完整声明进程外依赖。

`host.settings.json` 是管理员拥有的、完整的 JSON，不是算法输入。其 `recipe`、`spec`、`workspaceRoot`、`authorityId`、`builder`、`compiler`、`hitch`、`workspace`、`operationLimits`、精确角色目录 `roles`、`modelDestination` 和 `runtimeResources` 都是必需项。AHE/Evo 还需 `passThreshold`，Evo 还需显式 `evoSkillDisclosureId`。Git 仓库、`workspaceRoot`、Hitch/编译器可执行文件必须是实际存在的绝对路径；`builder.targetRoot`/`workspace.targetRoot` 则是同一 Git 仓库内的相对目录（例如 `harness`）。`modelDestination.module` 是闭合目录中的本地文件。管理员对每个操作种类配齐与 Campaign budget 来源一致的预留维度，不能把真实 token 的 stop 计量写成强制 hard。完整、可执行的**合成数据**设置生成过程见 [`recorded-check.mjs`](recorded-check.mjs)；它是测试夹具，不是生产模型注册代码。

`runtimeResources` 需要人工完整列出编译器脚本、子进程加载的本地模块和其他传递文件依赖。工厂会摘要已声明文件、编译器与 Hitch 可执行文件、设置、模型模块、Node 与完整 Hitch 子进程环境，并在恢复时拒绝漂移；它不自动发现任意子进程的全部依赖。模型模块字节和路由一致，只能证明本地准入配置，不能证明远端模型权重或服务行为。真实模型调用前，由管理员指定并授权数据目的地；不要把用户数据附在未授权的模型提示词中。

Fresh seed 宿主从编译后的 seed 数据集封存任务和 prompt，不要求旧 evolution/GEPA round。它只授权 `overview` 和 `task-report`，`historyTraceAvailable=false`；没有历史轨迹时不生成假 `trace-chunk`。新 rollout 的失败轨迹仍可由绑定 producer receipt 的角色工具读取。Evo 的宿主同时维护绑定的 Skill 库、成员读取授权和真实 Git Skill overlay；AHE/Evo 的分数取自受信 Hitch evidence。历史任务/轨迹需另用[历史源](../history-input/README.md)核验导入。

当前 `npm run test:algorithm:package` 验证新默认显式状态入口：安装本地 npm tarball 与 wheel，在包外运行双语言 CLI 和教学算法。本目录的 `recorded-check.mjs` 是旧内部 recipe 装配夹具，不能据此推断新公共入口或真实模型成功。旧 recipe 的受限 DSH 工具、Git 提交、录制 Hitch 与恢复行为继续由 `tests/unit/algorithm-default-{rho,ahe,evo}.spec.ts` 覆盖。物理验证的事实以具体环境与测试记录为准。
