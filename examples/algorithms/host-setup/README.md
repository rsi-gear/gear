# 给 RHO、AHE、Evo 配置物理宿主

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

`gear.algorithm.json` 的 `hostProfile` 条目指向 `{"language":"typescript","module":"./host.mjs","export":"hostProfile"}`，`algorithm` 条目仍单独指向 `gear_algorithm.recipes.rho`、`.ahe` 或 `.evo` 的 `algorithm`。不要在宿主模块再实现一份科学状态机。`model.mjs` 必须提供**真实** `registerModel(llm)`：它在传入的 DSH runtime 中注册目标 provider/adapter，并返回 `{destinationId, currentDestinationId}`；工厂会检查所报目的地、实际已注册 provider 和可解析的模型。只返回匹配字符串而未注册 adapter 会失败。受限 ESM loader 只允许本地静态相对导入与公开 `rsi-gear/algorithm*` 导入；其他本地模型适配代码须预先打包进闭合目录，不可用动态导入绕过身份。

`host.settings.json` 是管理员拥有的、完整的 JSON，不是算法输入。其 `recipe`、`spec`、`workspaceRoot`、`authorityId`、`builder`、`compiler`、`hitch`、`workspace`、`operationLimits`、精确角色目录 `roles`、`modelDestination` 和 `runtimeResources` 都是必需项。AHE/Evo 还需 `passThreshold`，Evo 还需显式 `evoSkillDisclosureId`。Git 仓库、`workspaceRoot`、Hitch/编译器可执行文件必须是实际存在的绝对路径；`builder.targetRoot`/`workspace.targetRoot` 则是同一 Git 仓库内的相对目录（例如 `harness`）。`modelDestination.module` 是闭合目录中的本地文件。管理员对每个操作种类配齐与 Campaign budget 来源一致的预留维度，不能把真实 token 的 stop 计量写成强制 hard。完整、可执行的**合成数据**设置生成过程见 [`recorded-check.mjs`](recorded-check.mjs)；它是测试夹具，不是生产模型注册代码。

`runtimeResources` 需要人工完整列出编译器脚本、子进程加载的本地模块和其他传递文件依赖。工厂会摘要已声明文件、编译器与 Hitch 可执行文件、设置、模型模块、Node 与完整 Hitch 子进程环境，并在恢复时拒绝漂移；它不自动发现任意子进程的全部依赖。模型模块字节和路由一致，只能证明本地准入配置，不能证明远端模型权重或服务行为。真实模型调用前，由管理员指定并授权数据目的地；不要把用户数据附在未授权的模型提示词中。

Fresh seed 宿主从编译后的 seed 数据集封存任务和 prompt，不要求旧 evolution/GEPA round。它只授权 `overview` 和 `task-report`，`historyTraceAvailable=false`；没有历史轨迹时不生成假 `trace-chunk`。新 rollout 的失败轨迹仍可由绑定 producer receipt 的角色工具读取。Evo 的宿主同时维护绑定的 Skill 库、成员读取授权和真实 Git Skill overlay；AHE/Evo 的分数取自受信 Hitch evidence。历史任务/轨迹需另用[历史源](../history-input/README.md)核验导入。

在仓库中执行 `npm run test:algorithm:package` 检查安装后的 npm 公开入口与独立 Python wheel。包外 [`recorded-check.mjs`](recorded-check.mjs) 在已安装包的外部项目中生成合成 Git/编译数据集、`host.settings.json`、`host.mjs`、`model.mjs` 和 Campaign JSON，使用已安装包的**内部 v1 `algorithmCommand`** 与干净 venv 的 wheel 执行旧 `check`，作为物理 provider 可装配的回归 oracle；这不承诺公开 v2 CLI 接受旧 RunSpec。该录制 adapter **不会**发起模型请求或 Hitch evaluation。验证器会自动传入 `GEAR_ALGORITHM_PACKAGE_PYTHON` 和 `GEAR_ALGORITHM_PACKAGE_LEGACY_CLI`；若单独运行该脚本，须将这两个变量分别指向已安装 wheel 的 Python 与已安装 npm 包的 `lib/algorithm/cli.js`。同一包测试还会验证公开 CLI 明确拒绝 v1 RunSpec，并从已安装包和 wheel 初始化、载入两语言 v2 作者模板。生产 adapter 的 `check` 可能执行模型元数据查询，不能由录制夹具推断为离线。完整 RHO/AHE/Evo 的 Python recipe、受限 DSH 工具、Git 提交、录制 Hitch CLI 与恢复由 `tests/unit/algorithm-default-{rho,ahe,evo}.spec.ts` 离线覆盖。真实模型、Hitch daemon、GPU 和人工作者环境尚未验收；这些测试不能推断科学效果。
