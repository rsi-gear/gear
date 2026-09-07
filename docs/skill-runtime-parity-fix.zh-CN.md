# Skill 接入与检查器依赖解析一致性修复

后续对其它 Meta 干预动作的核验与 carrier `0.0.2` 修复见
[DSH 扩展运行时审计](dsh-extension-runtime-audit.zh-CN.md)。下文是 `0.0.1` 的原始修复记录。

## 核验结论

问题存在。核验基线为远端最新 `dev`：
`3cf26a8a36c386efbe14df2a6d1b5e1bfc433872`。
该版本还没有实验分支的运行时检查器。本分支先移入
`cb7b3f7`、`8ba29ab`、`615da26` 中的已有实现，再修复依赖布局及原生 Skill 接入。

使用实际安装的 `@deepseek-ai/dsh@0.1.1-rc.2`、`dsh-codex@0.2.6`、
`pi-ai@0.84.4`，对同一份带有静态
`import '@deepseek-ai/dsh-skill-filesystem'` 的候选文件进行独立对照：

| 候选根 node_modules | 结果 |
| --- | --- |
| Target 的 pnpm 依赖目录 | `ERR_MODULE_NOT_FOUND` |
| 原检查器的 DSH profile 递归 fallback | 导入成功 |

复现只导入模块，没有调用模型、运行 benchmark 或执行插件 `apply()`。
这证实“包存在于 DSH 依赖树”与“候选文件可以直接导入该包”是不同契约。

## 修复方案及实现

1. **固定 carrier 接入文件 Skill。** `fixed/target.patch.yml` 修改已有
   `skill-filesystem` 配置，将 `<repositoryRoot>/harness/skills` 加入
   `customSkillDirs`。沿用 `filesystem` provider 和原生 `skill` 工具；
   普通候选只需新增 Skill 文件及其资源。rc.2 base 的该行没有显式配置，
   因而不会丢失既有配置。未来部署叠加其它字段时，须考虑整段 config 替换语义。
2. **保持 Target 的依赖可见性。** 候选快照连接到固定 Target 安装的
   `node_modules`；profile fallback 仅供 profile 使用。检查器核对依赖声明、
   packageManager、pnpm workspace 配置以及候选已有锁文件，避免使用不同安装契约。
3. **验证真实原生调用上下文。** 创建真实 Agent，设置独立任务 cwd，通过该
   Agent 的 services 发现 Skill，并在原生 `skill` 调用中传递 Agent。
   不发送任务输入，阻止模型及网络请求。发现预期目录使用独立的 DSH 原生 parser，
   该预期扫描器不注册到运行时 registry，避免自证成功。
4. **保留检查边界。** manifest 快照覆盖未跟踪文件和删除；原候选不写入临时
   manifest。校验仍有超时、进程组回收、阶段报告、快照完整性检查及提交前复验。
   零次发现/读取明确返回 `not_checked`，不会把零次调用当作成功。
5. **更新 Meta 指导。** authoring guide 和可执行文档示例改为只维护文件 Skill，
   说明直接依赖、间接依赖和 import allowlist 的区别。自定义 provider 保留为
   有明确需要时的扩展方式。

真实 Agent 的引入还暴露了 `dsh-codex@0.2.6` 的释放次序约束：其
`tools/change` 监听会尝试刷新尚在 registry 中但正在关闭的 Agent。
检查器在所有加载和读取断言完成后，先停止该 provider，再释放 Agent 和根 context。
这是检查器的清理顺序调整，没有修改上游包或掩盖 disposer 错误。

## 回归证据

- `tests/integration/dsh-runtime-check.spec.ts`：普通文件 Skill、直接依赖可用、
  间接依赖不可用、真实会话 cwd、初始化抛错、缺失依赖/注入、错误层级、
  无效 frontmatter、读取拒绝、清理失败/超时、请求禁止、无 Skill、禁用模型调用、
  检查后再次编辑和 no-op compiler。
- 正例在 `candidate.check` 和 finalize 均验证发现与原生读取。
- 正例额外从最终 Git commit 导出归档，复制并迁移 pnpm 安装树，然后从独立
  任务目录启动真正的 `apps/cli/lib/bin.js`。测试 observer 调用真实 Agent 的
  原生 Skill 工具；不使用检查器或其快照构造逻辑。此归档同时证明 DSH 可访问
  间接 Skill 包，而候选根仍无法直接解析该包。
- 原候选 diff 和 manifest 在检查前后保持不变；进程回收和快照删除由 compiler
  单元测试覆盖。

本机执行结果（macOS，Node `26.5.1`，固定依赖经 pnpm `11.7.0`
`install --frozen-lockfile` 复核）：

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run build` | 通过 |
| 全量默认测试 | 541 通过，25 按条件跳过；42 个测试文件通过 |
| 真实 DSH rc.2 集成矩阵 | 17/17 通过，包含最终归档的真实 Target CLI 冒烟 |
| macOS 系统沙箱下的正例、间接依赖负例、真实会话 cwd | 3/3 通过 |
| npm 包内容检查 | 包含 `assets/dsh-runtime-check.mjs`；通过 |
| `git diff --check` | 通过 |

默认套件中按条件跳过的 DSH 运行时用例已在指定固定 runtimeRoot 的矩阵中单独
执行；其它平台和外部 Hitch 合约仍按原测试条件跳过。没有在本机执行 Linux
Harbor 容器；Linux 沙箱矩阵由已有 CI job 运行。

## 版本和部署边界

carrier 版本从 `0.0.0` 提升为 `0.0.1`，依赖版本不变。采用修复时应重新
bootstrap Target，记录新的 substrate commit、manifest digest、lock digest 和
打包 artifact 身份。不得修改历史 commit 或 evidence 来复用旧实验条件。

本次验证不调用模型、不运行 Harbor benchmark，也不改变服务器部署或旧评测。
上线时先做单个 Harbor Target 冒烟验证，再决定是否扩展到 43 个任务；正式评测
另行观察模型是否及时选择并使用 Skill。加载及原生读取成功不等于策略有效。
