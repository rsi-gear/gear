# DSH 其它 Meta 干预动作的运行时核验

本次在 `codex/fix-runtime-skill-parity` 的同一个 worktree 上，接续
`fec933c` 核对固定 Target 安装的 DSH `0.1.1-rc.2` 和 `dsh-codex@0.2.6`。
检查对象是 Meta 对 Target harness 的干预，包括插件、prompt/context、自定义
工具、pre/post hook、action verifier、workflow、routing 和 compaction。

## 确认的问题与修复

### 1. 注册成功不能证明模型输入可组装

rc.2 `dsh-system-prompt` 的 `section()` / `context()` 只注册 provider；
`assemble()` 才调用变量、动态正文及工具 schema provider。
`renderPrompt()` / `renderContextSnapshot()` 又会进一步检查严格模板变量。
真实 `dsh-agent-loop.preStep()` 组装的是同时带有 Agent 和 scope 的上下文。

原检查器没有进入这条路径。新增三项负例，在改动前全部错误返回 `ok: true`：

- 静态 prompt 引用不存在的 `{{gear_missing_variable}}`；
- 动态 context 的正文回调抛出异常；
- 工具已注册但未提供参数 schema，直到模型可见 schema 投影时才报错。

修复新增 `runtime.promptAssembly` 阶段：通过真实 Agent 的作用域组装模型输入，
调用原生系统 prompt 和动态 context renderer。三项负例现均准确失败于该阶段，
不发起模型请求。旧 checker 没有报告此阶段时明确返回
`not_checked / PROMPT_ASSEMBLY_NOT_REPORTED`，保持 v1 协议兼容。

### 2. 自定义工具的标准 helper 同样有间接依赖问题

原 carrier 中，候选文件无法解析 `@deepseek-ai/dsh-tools`。DSH 的原生工具
普遍使用该包的 `defineTool`，它负责参数验证、规范输出和 schema 转换。

carrier `0.0.2` 显式声明 `@deepseek-ai/dsh-tools@0.1.1-rc.2` 为直接依赖，
并更新 build 校验。不是开放整个 DSH profile fallback；Skill filesystem、
system-prompt、workflow 等未声明包仍不能由候选随意 import。prompt、hook 和
普通文件 Skill 可通过现有注入服务完成，不需要新增这些依赖。

验证安装中，直接暴露的 dsh-tools 与 DSH 使用的是同一实际模块实例，其 DSH
peer dependencies 都是 `0.1.1-rc.2`，Cordis 为 `4.0.1`。
Meta 指导新增可执行自定义工具示例，明确 `defineTool` 的属性规格与原始
ToolDefinition 的 JSON Schema 不同，对象必须指定 `additionalProperties`，
工具必须有 canonical output、renderer 和取消处理。

### 3. 检查会话缺少 headless 的模型选择初始化

rc.2 的真实 headless runner 在创建 Agent 时调用 `installModelSelection`，
为组装注册 provider/model 变量，并将选中的模型参数用于请求配置。
仅创建一个同名 Agent 并设置 `agentOptions` 并不等价。

检查器和独立 Target 测试 observer 均改为使用相同的 setup；新增正例验证
`{{provider}}/{{model}}` 以及动态 context 的 Agent/scope/cwd 一致。
此改动不会驱动 Agent 的任务回合。

### 4. 初始化失败后的清理报告

DSH `boot()` 在加载失败时可能已经释放 partial context。原清理逻辑仍读取
`ctx.loader.entries()`，会附带一个误导性的二次 cleanup failure。
现通过可选 service lookup 处理已释放的 Loader，仍保留真实清理异常和超时。
初始化、依赖和注入失败负例增加准确清理结果断言。

## 各干预动作的结论

| 动作 | 核对的 rc.2 实现 | 结论与验收 |
| --- | --- | --- |
| 插件 / preset 注册 | Cordis Include / Loader，固定 target-loader | 沿用相对模块名、named exports、inject；加载失败可被检查器发现。候选 preset 是顶层 overlay，不等于 native Agent preset 目录 |
| 静态 prompt / 动态 context | dsh-system-prompt；agent-loop.preStep | 原有漏检已修复；实际作用域组装及严格渲染均覆盖 |
| 自定义工具 | dsh-tools.defineTool/register/schemaOf/execute | 增加明确的固定依赖和示例；打包 Target 验证 schema 可见、合法/非法参数、canonical value 和渲染结果 |
| pre_action / post_action / action_verifier | dsh-tools 原生 pre/execute/post/result pipeline | API 与现有指导一致，无需额外 loader；打包测试保留真实 hooks，仅用安全 body 替代 bash，验证调用前拒绝、输出脱敏、零测试结果拦截 |
| 文件 Skill | dsh-skill-filesystem / tool-skill | 沿用上一轮修复，原生发现和读取继续通过 |
| Workflow | dsh-tool-workflow / workflow-worker-thread | 无自动文件扫描；脚本是无 Node/文件/网络能力的协调代码；打包测试运行 phase/parallel 的原生 worker 流程，启动 Agent 数为 0。指导对齐原生工具“用户明确要求 workflow/大规模编排”的使用约束 |
| Routing / Agent 生命周期 | dsh-agent 事件类型与 dispatch、agent-loop.buildRequest、installModelSelection | 原生事件名与模式一致；必须区分事件通知、waterfall、作用域和固定 launcher 的模型选择。没有模型调用，不声称验证完整路由行为 |
| Compaction | dsh-compaction-basic | 真实 summarizer 会调用模型，并修改 durable replay；不是普通静态 prompt，也不能由本次无模型检查证明。未发现现有指南中指向错误具体 API 的示例，补充检查覆盖边界 |

## 测试方式和边界

`tests/integration/dsh-runtime-check.spec.ts` 现在覆盖 22 个变体。
完整文档示例经 `candidate.check`、finalize 后，从最终 Git commit 导出归档，
复制并迁移 pnpm 安装树，再从独立任务目录启动 Target 自己的 CLI。
测试 observer 不调用 Gear checker，不改变候选模块可见性。

本次验证结果（2026-09-08，macOS，Node `26.5.1`）：

- 全量常规回归：544 passed、30 skipped；其中真实 DSH 集成需显式配置安装目录。
- 使用重新 bootstrap 的 carrier `0.0.2` 跑完整真实 DSH 矩阵：22/22 passed，
  包括最终打包产物的原生动作测试。
- 在系统沙箱内针对完整示例、prompt 缺变量、动态 context 异常、工具缺参数
  schema、间接依赖不可见运行验证：5/5 passed。
- TypeScript 类型检查、完整构建、Skill 结构校验和 `git diff --check` 均通过。

复跑真实 DSH 矩阵时，将 `GEAR_TEST_DSH_RUNTIME_ROOT` 指向本次新 carrier 的
bootstrap 安装目录；需要系统沙箱时设置 `GEAR_TEST_RUNTIME_SANDBOX=required`。
执行入口为 `tests/integration/dsh-runtime-check.spec.ts`，安装步骤见示例 README。

任何无任务数据的检查都无法为任意自定义工具、hook 或 workflow 自动生成可靠的
业务验收输入。此次没有新增通用执行框架或向 Meta 开放宿主机 shell。
Skill 读取只覆盖它实际经过的 hooks；未执行分支中的 lazy import 仍可能在调用时
失败。因此根 Skill、protocol 和 authoring guide 都明确剩余行为路径，不再让
Meta 从加载/组装成功推断任意动作已执行。

固定 carrier 从 `0.0.1` 升级为 `0.0.2`，需要重新 bootstrap 并记录新的
substrate、manifest、lock 与 artifact 身份。本次不更新服务器、不重写旧 evidence，
也不运行模型或 Harbor benchmark。
