# 候选运行时验证缺口：核验与修复方案

日期：2026-09-07。状态：已核验代码并完成本地复现；本文是待实施方案，尚未接入生产检查器。

## 1. 结论与核验范围

**问题存在。** `dev` 中尚未提供 Meta 可调用的、能报告实际 Target 运行时加载覆盖情况的固定检查管线。配置为 `/usr/bin/true` 时，带错误 loader 的候选也能得到 `candidate.check.ok: true`。指导要求验证新资源的运行时加载，但返回结果无法告诉 Meta 这项能力是否可用、是否执行。

核验基线为 `dev` 提交 `3cf26a8a36c386efbe14df2a6d1b5e1bfc433872`，与实验报告版本一致，包含 PR #15、#16。

本次独立核验了代码、示例配置、文档和本地复现，未读取服务器私有会话或重跑报告所列实验。因此，历史撤回动作及其公开理由仍以用户报告为依据；本次可以独立证实导致该判断的验证能力缺口，不能据此证明撤回的 Skill 加载失败。

## 2. 代码证据

| 位置 | 核验结果 | 含义 |
| --- | --- | --- |
| `src/capabilities.ts:506–523` | `candidate.check` 只接受 `compiler`；builder 返回后构造 `ok: true`、`compiler.ok: true` | 没有 runtime/Skill 执行覆盖信息；不能另选运行时检查 |
| `src/harness/builder.ts:194–204` | 检查 preset 形状、import allowlist，然后调用 compiler | 不解析实际安装依赖、不执行插件、不检查服务注入或 Skill registry |
| `src/harness/compiler.ts:25–90` | `compile()` 返回 `Promise<void>`；零退出码视为成功，成功输出未返回上层 | 现有接口只有成功/异常，无法携带结构化覆盖证明 |
| `examples/dsh-codex-luna/profile.patch.yml:28` | compiler 默认 `/usr/bin/true` | 缺口仍在仓库提供的部署示例中 |
| `examples/dsh-codex-luna/target-carrier/fixed/verify-carrier.mjs` | 只检查入口文件存在及 package 声明版本 | 即使改为运行 carrier 的 `build`，仍不等价于实际加载 |
| `skills/refine/references/dsh-target-harness.md:718–724` | 已明确 no-op 不证明加载，并要求锁定运行时的发现/读取验证 | 指导正确，但未绑定可用的运行入口 |
| `src/refine/finalization-readiness.ts` | 根据 baseline 诊断、访问和引用证据生成 readiness | 不检查插件或运行时，不能承担加载 readiness 语义 |
| `tests/composition/target-skill-loader.spec.ts:37–61` | 测试真正调用 DSH Skill registry 和原生工具，但手工装配服务，`agents` 为占位对象 | 证明文档示例的局部组合，不证明任意候选在实验 carrier 上加载 |
| `package.json:126–127` 与 example carrier package | Gear 测试锁定 Skill 包 rc.8，Target 声明 DSH rc.2 | 不得把 Gear 测试依赖当成 Target 锁定运行时 |

### 本地复现

运行 `repros/candidate-runtime-validation/vitest.config.ts`：**4/4 通过**。通过代表成功复现当前缺口。

| 输入候选 | 当前可观察结果 |
| --- | --- |
| 文档中的完整 Skill 接入 | `ok: true`，无 runtime coverage |
| `apply()` 主动抛出错误 | `ok: true`，无 runtime coverage |
| import 不存在的 `@deepseek-ai/gear-runtime-gap-nonexistent` | `ok: true`，无 runtime coverage |
| provider 指向不存在的 `../missing-skills/` | `ok: true`，无 runtime coverage |

使用真实 capability、builder、Git 候选工作区和 `/usr/bin/true` 子进程，仅替代无关的 active-round 服务状态。测试还确认 `check: "runtime"` 被拒绝，检查未更新候选 manifest。没有请求模型或运行 benchmark。

对照运行 builder、示例 carrier、文档 Skill 组合的既有测试：**45/45 通过**。这些是回归及局部加载证据，不能升级为本次 Target 的完整运行时证明。

## 3. 不能只替换 compiler 命令的原因

### 3.1 当前候选的 manifest 尚未生成

`finalizeWorkspace()` 在调用 compiler **之后**才生成新 manifest；`checkWorkspace()` 不生成 manifest。真实 `target-loader.js` 会逐项验证摘要，并拒绝未声明文件。直接加载正在编辑的工作区会把正常编辑误判为 manifest 完整性错误。

必须先在临时副本中生成匹配当前候选字节的 manifest。使用 builder 的同一份 manifest 构造逻辑；不要要求 Meta 写 manifest，也不要在原候选上临时覆盖、失败后再恢复。

### 3.2 加载等待完成不等于服务激活成功

Cordis 可以有未激活、等待注入或初始化失败的 fiber。只执行 `ctx.plugin()` 或等待队列清空不足以覆盖这些状态。

已检查本机安装的 DSH `0.1.1-rc.2`：`@deepseek-ai/dsh-app-boot` 提供 `boot`、`assertEntriesLoaded`、`assertEntriesActivated`，其 boot 流程执行 loader 等待和启动审计。实现应复用该锁定包的流程，而不是重写一套简化“加载器”。当前只读取了这些 API 的实现，尚未做完整 rc.2 carrier 冒烟执行。

### 3.3 空 Skill 列表不能算成功

路径错误、漏注册和 malformed frontmatter 都可能表现为没有发现任何 Skill，未必抛出异常。只遍历发现结果并读取，会出现“循环零次也通过”。必须建立预期候选 Skill 清单并逐项核对实际发现结果。

### 3.4 现有进程结束处理不保证无残留

compiler 当前只向直接子进程发送信号，监听 `exit` 后清理定时器；后代仍可能存在或持有输出管道。该实现不能支持报告中“无残留进程或资源”的强验收条件。需要对进程组或容器生命周期实施超时和清理，并等待输出关闭。

## 4. 推荐方案：一个固定 compiler 管线，增加可信检查报告

保留 `candidate.check({check: "compiler"})` 入口，不增加 Meta 任意命令参数，不开放 shell，不让候选选择依赖或运行时版本。Gear 核心保留 harness 无关的检查协议，DSH 适配放在固定 checker 和 carrier 侧。

执行顺序：

```text
candidate.check
  → 候选边界、preset、import 静态检查
  → 绑定当前候选内容的检查请求
  → 固定 compiler / DSH checker
      → 临时副本 + 当前 manifest + 锁定的 Target 依赖
      → 实际 carrier loader / preset / plugin tree
      → 原生加载与激活状态审计
      → Skill 发现、来源核对、原生 skill 工具读取
      → runtime dispose + 进程和临时资源清理
  → Gear 校验报告并向 Meta 返回各阶段结果
```

### 4.1 通用检查报告和兼容行为

建议新增可选 compiler 报告协议标识，例如 `compiler.reportProtocol: "gear-check-v1"`，以及受限的报告字节上限。名称可在实现时统一；关键是协议由部署者配置，Meta 和候选不能修改。

`HarnessCompiler.compile` 从只返回 `void` 扩展为可返回结构化报告，兼容原有 `void` 实现；`checkWorkspace` 将静态检查和 compiler 报告组合返回。失败保留已完成阶段，后续阶段明确为未检查，不再只抛出一条无法区分覆盖范围的文本。取消和身份失效仍按原控制流处理。

报告阶段使用 `passed | failed | not_checked`。没有候选 Skill 的场景由 `not_checked + reason: no_candidate_skills` 和计数表达，避免零次执行被写成读取成功。

对于 legacy/no-op compiler，返回示意：

```json
{
  "ok": true,
  "okScope": "configured_checks",
  "static": { "status": "passed" },
  "compiler": { "ok": true, "status": "passed" },
  "runtime": {
    "load": { "status": "not_checked", "reason": "compiler_did_not_report_runtime_evidence" },
    "skillDiscovery": { "status": "not_checked" },
    "skillRead": { "status": "not_checked" },
    "cleanup": { "status": "not_checked" }
  },
  "warnings": ["RUNTIME_VALIDATION_UNAVAILABLE"]
}
```

不靠命令名识别 no-op：任意不产生协议报告的 legacy compiler，包括 `/usr/bin/true`，均没有运行时验证证据。保留 `ok` 兼容，但明确它只汇总配置的检查；`finalizationReadiness` 保持现有诊断前置条件语义。

若部署声明 `gear-check-v1`，但程序零退出且没有报告、报告截断、schema 错误、必需阶段缺失或候选摘要不符，检查必须失败，不能回退为普通成功。这样能发现 checker 被误配为 `/usr/bin/true` 的情况。

报告至少绑定：请求标识、parentRef、候选内容摘要、manifest 摘要、固定 checker 标识、实际 runtime 版本、依赖锁/固定环境标识。每个失败阶段包含稳定错误码、有限长度的原因、相对插件路径或 Skill 名、修复方向。区分 `candidate` 与 `environment` 原因，例如缺失固定运行环境时应提示部署修复，不能要求 Meta 改依赖。

使用独立的结构化报告通道与有界诊断日志，禁止从插件 stdout 中搜索“成功”字样作为结果。结果是固定检查程序的可观察证据，不应宣传成对任意敌对插件的密码学证明。子进程输出必须经现有公开结果的脱敏和长度限制后返回 Meta。

### 4.2 候选快照和固定环境

Gear 提供当前候选身份及 manifest 描述；固定 checker 只在独立临时根中构建副本。共享/提取 builder 的 manifest 构造辅助函数，避免两套摘要算法。

副本包括真实固定 carrier 文件和完整候选 artifact 树，包含新增文件、删除结果及未改动文件。不能用 `git archive HEAD` 代替当前候选，也不能只复制 diff。固定依赖来自部署准备好的只读环境，保留 Node/pnpm 的实际解析关系，禁止意外回退到 Gear 的 rc.8 `node_modules`。

读取开始、复制完成、返回前核对候选摘要，检查过程中若发生并发编辑，返回 `CANDIDATE_CHANGED_DURING_CHECK` 或使结果明确失效。现有 `withOpenWorkspace` 主要跟踪在途操作，不能把它当作排他锁。首版不缓存检查结果，降低旧结果复用风险。

运行时只能读取快照 artifact 和固定依赖；写入独立临时 workspace、settings、HOME/DSH_HOME/XDG/cache/tmp。原候选、Git 元数据和固定工具链不给运行时写权限。快照中的 manifest 由检查器在启动前写入。

当前 compiler sandbox 只允许写 targetPath，也未显式声明外置完整工具链读路径。接入时需给固定检查程序增加专用 scratch 根和固定 runtime 的只读路径；不能仅修改 command 后继续沿用原权限布局，也不能把任意路径参数交给 Meta。

### 4.3 真实 DSH 启动及 Skill 检查

使用与 Target 相同的锁定 DSH rc.2、依赖锁和有效配置组合，通过 `dsh-app-boot` 加载同一 carrier `target-loader`、候选 preset 和插件树。采用固定的 smoke overlay，禁用会自动开始任务的 `headless-runner` 及与检查无关的交互/遥测入口；保留候选真实依赖的服务。

rc.2 `headless-runner.apply()` 会直接启动单次任务，所以不能先启用它再寄希望于“初始化后立即退出”。也不能拿占位的 `skills`、`tools`、`agents` 对象冒充生产服务来宣称完整加载。所有 smoke overlay 与 Target 的差异应记录在检查配置中，并有组合一致性测试。

依次完成：

1. 通过相同 carrier 完整性校验和 Include 路径加载候选；等待并审计激活状态，捕获未满足注入、模块解析失败、同步/异步初始化错误，报告插件身份。
2. 从完整候选 `skills/` 形成预期资源清单，用锁定 DSH 的解析/扫描逻辑解释 name、frontmatter 和支持的目录布局。这个清单仅用来发现“应发现但未发现”的缺项，不能替代真实运行路径。首版标准目录的非法或不支持布局返回明确诊断，不能静默忽略。
3. 调用真实 `ctx.skills.list` / `get`，核对每个预期 Skill 的来源路径位于候选快照，对应目标 provider；发现同名外部 Skill 不算候选成功。校验 provider 身份和资源路径，并处理名称冲突。
4. 用真实 `ctx.tools.execute({name: "skill", ...})` 读取每个应支持模型调用的 Skill；核对非错误结果、name、provider、资源来源及原生工具返回内容。依据锁定 DSH 解析后的 body 计算摘要，与预期候选内容对应，不能只判断结果非空。
5. 明确设置禁止模型调用的 Skill 的处理：可验证 discovery，但原生 model-facing 读取标记未执行及原因；若候选 policy 却要求模型通过该工具读取，则报告契约冲突。不能把这种合法元数据等同于缺失 loader。
6. 无候选 Skill 时仍执行运行时加载和清理；Skill 检查返回数量 0 及原因。loader-only 修改也要验证全部仍存在的候选 Skill，不能只看新增文件。

不调用 agent 的生成/运行方法，不调用 Hitch/evaluator。运行环境不带模型凭据且禁止联网；固定启动配置禁止模型调用，检测到模型请求意图即失败。隔离是兜底，不能把一个失败的模型请求当作“未请求模型”的成功检查。

首轮范围为组合加载、服务激活、标准候选 Skill 发现与读取。hook/tool 的注册问题可通过加载暴露，但其业务行为、完整 benchmark 效果仍需另行验证。

### 4.4 生命周期和提交一致性

启动、检查、dispose 各有阶段记录，清理必须在 `finally` 中执行。启动失败也要释放部分 context，保留初始化主错误和清理次错误。dispose 超时不得无限等待。

固定 compiler 设置总超时、报告大小和日志大小限制。父进程管理整个进程组或容器：温和终止后强制回收，覆盖父进程先退出但后代仍存活的情况；等待输出 `close`，并在成功、失败、取消、超时和启动异常所有路径清理临时根。Linux/macOS 分别验收；无可靠隔离能力的平台报告环境不支持，不能声称满足强清理保证。

`candidate.check` 和 `finalizeWorkspace` 调用同一检查管线。提交时对封存的最终内容重跑固定检查，不凭编辑前一次通过放行；运行时检查不得改写候选 artifact。报告身份必须对应最终待提交内容。保留历史 compiler 产物语义时，先完成构建，再对最终产物快照验证，禁止“验证一份、提交另一份”。

阶段报告和身份信息随现有 round/candidate 证据持久化，Meta 在当次调用得到相同摘要；旧数据缺字段解释为未检查，不能反向补记通过。无需建立新的执行调度框架。

## 5. 建议改动范围

| 文件/模块 | 改动 |
| --- | --- |
| `src/harness/builder.ts` | 提取一致的 manifest/候选身份构造，返回检查报告；check/finalize 共享检查及最终身份核对 |
| `src/harness/compiler.ts` | 可选报告协议、结构化失败、报告/日志分离、固定 scratch 与工具链权限、子进程树回收 |
| `src/types.ts` 或独立 check 类型模块 | 通用阶段状态、报告身份和有界诊断；保持 DSH 专用逻辑在适配侧 |
| `src/config.ts` | 固定报告协议及输出限制配置，legacy 兼容 |
| `src/index.ts`、`src/skill/control-plane.ts` | 同步接入 Native DSH 与 skill/Codex Meta 两条装配路径 |
| `src/capabilities.ts` | 转发实际覆盖、未检查原因和可修复错误；不改 readiness 为 runtime 结论 |
| `src/refine/service.ts`、round/candidate 状态持久化 | 记录绑定候选身份的检查证据，提交前重跑，旧数据兼容 |
| 固定 DSH checker 与 smoke overlay（新增） | 部署到候选不可改位置；复用真实 Target boot、carrier 与原生 Skill 工具 |
| `examples/dsh-codex-luna/profile.patch.yml`、bootstrap/部署准备流程 | 准备并锁定实际 runtime；默认接入真实 checker，检查时不安装依赖 |
| `skills/refine/references/dsh-target-harness.md`、`target-harness-editing.md`、`protocol.md` 和工具说明 | 明确检查覆盖含义、能力可用性和修复动作，不能因缺少检查能力要求一律退回 prompt |

Meta 在首次得到候选上下文时应能看到当前固定检查器能力。未配置运行时检查时，提示“该阶段未检查、需部署补齐”，允许明确记录未验证范围；不要求它必须选 Skill，也不因报告缺失引入自动 prompt-only 策略。真实 checker 已启用后，明确加载失败必须修复或撤回相关改动，不能忽略失败。

## 6. 测试与验收矩阵

| 场景 | 预期 |
| --- | --- |
| 正确的新 Skill、loader、preset | 实际 rc.2 carrier 加载成功，来源匹配，原生读取内容匹配，清理成功 |
| `/usr/bin/true`，无报告协议 | compiler 通过；runtime/Skill 明确未检查 |
| `/usr/bin/true`，声明报告协议 | 缺少必需报告，配置/协议失败 |
| 同步/异步初始化抛错、缺失 import、未满足 inject | runtime.load 失败，定位插件/依赖/服务；后续未检查 |
| 漏 loader 接入、错误 Skill 目录、非法 frontmatter | discovery 失败，有预期但未发现的资源信息，不得零条通过 |
| registry 可见但原生工具缺失、读取错误或内容不符 | skillRead 失败，保留 discovery 通过证据 |
| 同名外部 Skill 遮蔽候选 | 来源/内容核对失败 |
| loader-only 改动破坏既有 Skill | 检查全部候选 Skill，暴露失败 |
| 无 Skill、显式禁用模型调用 | 区分未执行原因和数量，不虚报 native read 成功 |
| 未封存编辑且父 manifest 过期 | 副本生成匹配 manifest 后加载；原候选及 Git 状态不变 |
| 修改候选后复用上次结果，或检查时发生编辑 | 摘要不符，结果失效；finalize 必须重跑最终内容 |
| 运行时版本/依赖锁不符，工具链缺失 | 环境错误；无在线安装、无 rc.8 回退 |
| 模型调用、任务启动、联网尝试 | 检查失败；生成/evaluator/benchmark 调用计数必须为零 |
| 超时、取消、dispose 拒绝、后代进程、输出爆量 | 有界失败报告；回收全部所属进程、管道和临时资源 |
| Meta 两种入口及旧 round 记录 | 同一覆盖结果，旧记录表示未检查，不破坏原提交诊断要求 |

运行时集成测试使用 Target 锁定的 rc.2 依赖，与 Gear rc.8 组合测试分开。可以使用本报告复现中的负例，但新的测试应断言它们在相应运行阶段失败。为清理验收添加创建后代/打开 watcher 的固定测试插件，并从外部进程观察回收，避免只测试 `dispose()` 被调用。

## 7. 实施顺序与上线条件

1. 先接入报告类型、legacy 未检查语义和两条 Meta 路径，补协议测试；同时在指导中暴露当前能力。
2. 实现固定 DSH checker、临时副本与真实 boot，跑 rc.2 正反例以及生命周期验收；把它接入同一 compiler 协议。
3. 更新示例和 release 部署生成流程。在 shell 禁用配置下，通过 Meta 的真实 `candidate.check` 验证正确 Skill、错误 loader 和 no-op 的不同结果，再启用新实验。

三个步骤共同构成永久修复。只改提示词、只添加测试或只让结果多一个警告，都不算完成用户验收。

新检查器、依赖锁或固定环境变化需要记录新的 toolchain/checker 身份并应用于新的 release/evolution；不要悄悄替换正在进行中的实验环境，也不要把旧检查记录标成已验证。现有服务器 release 使用 `/usr/bin/true` 的事实不会因为合并代码自动改变，部署配置必须同步更新。

本轮交付为可复现证据和上述实施方案；生产实现、服务器部署及 Target rc.2 完整冒烟验收仍待后续实施。运行时加载成功与 benchmark 成绩改善继续分别评价。
