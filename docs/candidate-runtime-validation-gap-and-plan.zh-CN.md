# 候选运行时验证：缺口、实现与部署

后续核验发现原检查器的 profile fallback 会扩大候选依赖可见性；本分支已按
[Skill 运行时一致性修复](skill-runtime-parity-fix.zh-CN.md) 改为 Target 依赖布局，
并由固定 carrier 接入普通文件 Skill。下文保留初始验证接口与部署设计。

## 问题与修复范围

修复前的核验基线为 `dev` 提交 `3cf26a8a36c386efbe14df2a6d1b5e1bfc433872`，包含 PR #15、#16。Meta 已能创建、修改和接入 Skill，但 `candidate.check` 只运行静态规则和配置的 compiler。配置为 `/usr/bin/true` 时，即使插件初始化抛错、依赖不存在或 Skill 目录错误，也会返回 `ok: true`，且没有运行时覆盖信息。

本分支现已实现生产修复：固定 DSH checker、候选临时副本、分阶段检查报告、提交前复验，以及示例部署配置。最初的 4 个复现已迁入默认单元测试，验证 legacy compiler 必须明确报告运行时未检查；真实运行时负例由 rc.2 集成测试覆盖。

本修复不代表原实验中撤回的 Skill 加载失败，也不代表 Skill 一定改善分数。历史撤回动作以实验报告为依据；这里独立验证的是检查能力及其执行路径。未读取服务器私有会话，未请求模型或运行 benchmark。

## 实际执行路径

```text
candidate.check({check: "compiler"})
  → 候选工作区边界、preset 和 import 静态检查
  → builder 构造当前候选 manifest（不写回原候选）
  → 固定 compiler 创建临时副本与匹配的 manifest
  → assets/dsh-runtime-check.mjs
      → Target 安装目录中的 DSH 0.1.1-rc.2
      → 相同 headless profile、target.patch.yml、target-loader 与候选 preset
      → DSH boot / assertEntriesActivated
      → 实际 Skill registry 发现 + 原生 skill 工具读取
      → runtime dispose 与清理错误审计
  → Gear 校验有界结构化报告、候选身份及副本内容
  → 回收整个进程组，删除临时副本，向 Meta 返回覆盖结果
```

未封存候选保留的是父版本 manifest，直接启动真实 carrier 会出现摘要或未声明文件错误。因此新检查器在临时副本中写入 builder 根据当前字节生成的 manifest。原候选及其 Git 元数据不交给运行时修改。固定文件来自候选仓库的受控文件树，候选 artifact 包含新增、删除和未修改部分。

`finalizeWorkspace` 走同一 compiler 管线并重跑最终内容；不能凭先前一次成功检查提交后来改坏的候选。最终检查报告随 `CandidateRecord.validation` 持久化，报告中的候选摘要应与最终 manifest 摘要相同。`candidate.check` 的当次结果仍由现有工具事件记录，无需新增执行调度框架。

## 检查实际覆盖什么

| 字段 | 含义 |
| --- | --- |
| `static` | 工作区、preset 和 import 静态检查 |
| `compiler` | 固定程序的执行及报告协议结果 |
| `runtime.load` | 实际 carrier、插件树及服务激活审计 |
| `runtime.skillDiscovery` | 候选预期 Skill 是否实际进入 registry，且来源路径对应候选 |
| `runtime.skillRead` | 原生工具成功读取，名称、provider、来源、内容及可见文本匹配 |
| `runtime.cleanup` | DSH dispose 是否完成，包括 Cordis 仅记录到 logger 的清理错误 |
| `finalizationReadiness` | 原有诊断、证据访问等提交前置条件，不代表运行时加载 |

阶段状态为 `passed`、`failed`、`not_checked`。`okScope: "configured_checks"` 明确顶层 `ok` 的范围。

未声明报告协议的 legacy compiler，包括 `/usr/bin/true`，可以 `compiler.ok: true`，但 runtime 各项明确为 `not_checked / RUNTIME_VALIDATION_UNAVAILABLE`。若声明了报告协议，零退出码但报告缺失、非法、超限、身份不匹配或覆盖不完整，都属于失败。

`harness.current.validation` 提前暴露 runtime 检查是否已配置。能力不可用本身不是 Skill 无效的证据，也不要求 Meta 一律改用 prompt。真实检查失败时，Meta 获得阶段及有界诊断，可以修复后重查。

## DSH 运行路径与限制

检查器从固定 `runtimeRoot` 解析真实安装的 DSH 和 Skill 相关包，要求版本为 `0.1.1-rc.2`，记录该环境 `pnpm-lock.yaml` 的摘要。DSH 自身的模块 fallback 仅供 profile 使用，候选根连接到真实 Target 的依赖目录，避免扩大候选导入范围或意外使用 Gear 的 rc.8 开发依赖。检查不安装依赖，不修改 Target 安装目录。

检查加载 Target 的实际 headless 组合和 carrier patch。固定 smoke overlay 在启动前禁用 `headless-runner`、`headless-startup`、HMR 和遥测，并配置 Target 默认模型选择。模型服务仍为真实服务，检查器不调用生成方法；LLM stream 和 fetch 有禁止请求的守卫。没有占位的 `skills`、`tools` 或 `agents` 服务。

使用锁定 DSH 的 `FileSystemSkillProvider` 在 registry 之外解析预期清单，这份清单仅用于对照。实际成功必须通过候选注册的 registry 和原生 `skill` 工具，不能由扫描器代替。支持 `skills/<name>.md` 和 `skills/<name>/SKILL.md`；非法 frontmatter、不支持的嵌套 SKILL.md、重复名称、漏注册、错误目录和来源遮蔽都不能静默通过。

无候选 Skill 时仍检查加载与清理，Skill 阶段标记 `NO_CANDIDATE_SKILLS`。显式禁止模型调用的 Skill 验证发现和内容，但不声称通过模型工具读取，使用 `MODEL_INVOCATION_DISABLED` 和每个资源的读取状态表达。已有 Skill 也会检查，因此 loader-only 修改不会漏过。

范围是加载及 Skill 读取冒烟测试。其他 hook/tool 的业务行为、模型是否选择 Skill、任务成绩仍由独立评估确认。

## 隔离与资源生命周期

生产部署使用 `metaSandbox.mode: required`。运行时只读候选副本和固定依赖；HOME、DSH_HOME、XDG、TMPDIR、settings、spill 和工作目录位于每次检查的独立可写临时根。系统沙箱禁止联网。固定 Node 的外置动态库可由部署配置的绝对 `compiler.readPaths` 提供只读权限，Meta 不能指定这些路径。

报告使用临时根内的独立文件，避免插件 stdout 混入结果，也避免额外文件描述符被 Linux 沙箱关闭。父进程拒绝符号链接、非普通文件和超过上限的报告。阶段检查点保留超时前已完成的阶段。报告和日志均有返回长度限制；Meta 侧复用现有脱敏逻辑。

compiler 总超时包含副本准备。父进程管理进程组，SIGTERM 后有 SIGKILL 截止时间，等待输出关闭；直接父进程退出时也回收其后代。Linux required 模式另有底层 bubblewrap PID namespace 和 die-with-parent 约束。成功、失败、取消和超时均删除临时根；dispose 抛错、仅记录错误或超时不会被写成清理成功。成功报告返回前还核对副本内容和原候选身份。

系统隔离测试已在 macOS 执行。Linux CI 已加入固定 Target 安装和同一集成矩阵，使用项目现有 air-gapped sandbox 策略；发布前仍应在部署主机验证，不要把 macOS 结果表述为 Linux 已验证。`sandboxMode: disabled` 只适用于受控本地测试，不能提供生产只读与隔离保证。进程组回收并非对任意恶意进程逃逸的跨平台安全证明。

## 部署配置

示例 `profile.patch.yml` 已切换到真实 checker，`evolve.mjs` 提供其绝对路径。旧 release 的 `/usr/bin/true` 不会因为更新 Gear 源码自动改变；部署新 release 时应同步更新 compiler，例如：

```json
{
  "compiler": {
    "command": "/absolute/path/to/node",
    "args": ["/absolute/path/to/gear/assets/dsh-runtime-check.mjs"],
    "reportProtocol": "gear-runtime-check-v1",
    "runtimeRoot": "/absolute/path/to/installed-target-carrier",
    "timeoutMs": 120000,
    "maxReportBytes": 131072,
    "env": {}
  }
}
```

`runtimeRoot` 必须已经有 Target 的 `package.json`、`pnpm-lock.yaml` 和实际安装的固定依赖。不要把 OAuth、模型密钥或 Meta HOME 放进 compiler 环境。直接启动示例 profile 时需设置 `GEAR_RUNTIME_CHECK_EXECUTABLE`；通过 `evolve.mjs` 启动会自动设置。

检查器随 npm 包和 `gear-dsh-runtime-check` bin 分发。Native DSH Meta 与 skill/Codex Meta 两条装配路径都使用相同 `config.compiler`，无需启用 Meta shell。

部署后先在 shell 禁用条件下执行正常 Skill、错误 loader、no-op 三类检查，确认结果不同，再开始新 evolution。固定 checker/工具链配置变化应记录在新的实验环境中。baseline 复用继续由既有身份校验决定，不手工绕过有效性检查，也不把旧检查记录追记为已验证。

## 验证入口

单元测试覆盖报告缺失、非法、超限、身份不匹配、虚假的零条通过、非零退出的阶段错误、日志噪声、no-op 覆盖，以及超时/取消/父进程退出时的后代回收与副本删除：

```sh
npx vitest run tests/unit/harness-compiler.spec.ts tests/unit/candidate-check-coverage.spec.ts
```

真实 Target rc.2 测试验证正常 Skill、初始化失败、依赖/注入缺失、路径/注册/frontmatter 错误、原生读取被拒、清理抛错/超时、禁止网络请求、无 Skill、禁用模型调用、提交前重查及报告缺失：

```sh
GEAR_TEST_DSH_RUNTIME_ROOT=/absolute/path/to/installed-target-carrier \
GEAR_TEST_RUNTIME_SANDBOX=required \
npx vitest run tests/integration/dsh-runtime-check.spec.ts
```

没有设置运行环境时，这组集成测试明确跳过，不应算作通过。Gear 既有 rc.8 文档组合测试继续独立保留。运行时加载成功与 benchmark 成绩改善继续分别评价。
