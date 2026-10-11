# A1 历史 rejected sealed candidate reader：独立只读审计

状态：**本 bounded history/state 片段无剩余 functional blocker，可以提交。** 范围仅 `src/history/nonwinner.ts`、其单测、`src/state/evolution.ts` / `store.ts` 的纯解析接口及对应状态测试；不审核 A2、旧 journal 恢复、真实远端导入的全部功能。未修改仓库或源实验。

## 已核对的正向合同

- 只接受 round `rejected` / `rejected-for-substrate`、所选候选有 sealedVersion 且不是 promoted winner；来源 ID 安全、状态 spec/round 经原校验器纯解析，registry/spec/round 起末重读比对字节 SHA。`sourceFile` 16 MiB 上限，按块读取，拒绝源记录 symlink 外逃与缺件。
- Git reader 核验 sealed commit/tree、immutableRef、目标 manifest digest 和其中 artifact 字节；`patchDigest` 显式声明只保留原记录，未伪称重算。新 binding 的 harness 槽和其他 refs 在新 CAS 中验证，跨 repo 拒绝，provenance 明说不继承预算、pending operations、measurements。没有调用旧 runtime/compiler。
- 原状态 `validateEvolutionSpec` / `parseRound` 只解析已解码对象，避免第二次调用原 store `read*` 的无界读取；同一规则用于既有状态读写，状态测试覆盖有效/无效样例。

## 已修复的审计发现

1. **新 CAS 与源路径隔离。** 原 preflight 只排除旧 state root；现在 [分离检查](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/history/nonwinner.ts:168) 同时排除源仓库、linked worktree 的 Git common 目录及其祖先/子路径，解析 realpath 和符号链接；import 在写新 CAS 前重复检查。文件存储构造会创建目录，因此未来真实 host 仍须先调用该 preflight，再构造 `FileArtifactStore`。仓库内 CAS、symlink 别名、Git common 目录均有负例。
2. **旧 sealed Git parent 与固定 substrate。** [只读 lineage 验证](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/harness/builder.ts:239) 现在核对实际单一 Git parent 等于记录的 parent，并以 NUL 分隔的完整 Git diff 名单拒绝 targetRoot 外的改动；原有 commit/tree/manifest/artifact 验证仍保留。伪造 parent、merge commit、有效 manifest 同时改固定 substrate 的负例已覆盖。`patchDigest` 仍明确为 `recorded-only`，没有虚称重构原 patch。
3. **缺失源 root 的稳定原因码。** preflight 单独处理旧 state root 的 `ENOENT`，import 现在也报告 `source-record-missing`；repo/common 解析失败仍报告 `repository-mismatch`。

## 验证

独立执行 `npm test -- tests/unit/history-nonwinner.spec.ts tests/unit/evolution-state.spec.ts tests/unit/state-store.spec.ts`：**3 files / 44 tests 全通过**。主审另报告包含 task-sampling 的 4 files / 49 tests 与 typecheck 通过，这不是本独立复测。主审将在 Aliyun 真实 nonwinner 上做实际导入探针；本地 fixture 是新造兼容测试，不能替代真实来源证明。当前片段不做编译/评价、不接续旧 journal、不迁移 Git 对象；同 repo 保留义务和真实 profile/CLI 连接属于后续门禁。
