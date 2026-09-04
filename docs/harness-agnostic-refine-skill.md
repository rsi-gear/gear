# Harness-neutral Refine Skill 与独立控制面

## 1. 结论

Gear 的 Meta 入口不再要求 DSH。可运行结构是：

```text
Codex / Claude Code / DSH / compatible harness
                  |
             refine skill
                  |
       owner-only local JSON protocol
                  |
         standalone Gear Core
                  |
      Hitch -> configured Target harness
```

`gear-refine serve` 不创建 DSH `Context`，直接构造 Gear 的 registry、candidate
workspace、evaluator、selection、promotion 和 skill lease gateway。DSH plugin
则把同一个随包 skill 发布到 DSH 原生 skill catalog，并提供调用同一 gateway 的
`refine_request` 工具；两者共享协议和候选编辑边界。

当前发布的 Target builder 仍以完整 DSH source repository 和 exact Git
commit 为版本单位，默认 rollout provider 仍是 Hitch `deepseek` adapter。
Meta/Target 生命周期已经分离；新增其他 Target 类型仍需相应的 builder 与
Hitch rollout provider，而不需要改动 Refine Skill 协议。

## 2. 安装

从源码构建并全局安装当前包：

```bash
npm ci
npm pack
npm install --global ./dsh-plugin-refine-0.1.0.tgz
```

包内包含：

- `gear-refine`：独立 server 与通用 client；
- `skills/refine/SKILL.md`：Agent Skills 入口；
- `dsh-plugin-refine`：发布同一 Skill 的 DSH plugin，并保留旧 adapter。

使用 standalone server 时，把 `skills/refine` 复制或链接到 Meta harness 的
skill 目录。不同产品的 skill 安装位置由该产品决定；不要复制一份并修改协议
或安全约束，否则它的 digest 将不再匹配 evolution identity。使用 DSH plugin
时不需要再复制：插件会以高优先级发布包内原件及其 references。

## 3. 固定 Meta identity

Skill mode 必须在启动前固定：

- runtime type，例如 `codex`、`claude-code` 或 `dsh`；
- runtime version 与 runtime artifact SHA-256；
- harness/skill id 与 `SKILL.md` SHA-256；
- provider、model 和 sampling。新配置省略 `maxTokens`，避免由 Gear 额外限制
  Meta 回合；旧 evolution 中已封存的值仍属于 identity。

DSH plugin 中若未填写任何 identity 字段，Gear 会从当前 DSH runtime 和包内
`skills/refine/SKILL.md` 自动派生并封存 identity；`refine_request` 还会校验
当前 DSH request 的 provider、model、`maxTokens` 和 temperature 与配置一致。Standalone 或
外部 Meta harness 必须显式提供全部 identity 字段。

显式配置时，`metaAdapter.runtimeIntegrity` 与 `metaAdapter.harnessDigest` 使用
`sha256:<64 lowercase hex>`。例如计算当前 skill 文件：

```bash
shasum -a 256 skills/refine/SKILL.md
```

在配置和 `meta.claim` identity 中使用同一个带 `sha256:` 前缀的值。Gear
会把这些字段写入 immutable `EvolutionSpec`；claim、continue 和恢复时不匹配
都会 fail closed。

## 4. Standalone 配置

以下是核心字段示例。路径、commit、manifest digest、模型和 identity 必须替换
为部署的真实值：

```json
{
  "workspaceRoot": "/absolute/control-workspace",
  "stateRoot": "/absolute/control-workspace/.gear-refine",
  "dshRepository": "/absolute/target-dsh-repository",
  "targetRoot": "harness",
  "metaModel": {
    "provider": "openai",
    "model": "gpt-5"
  },
  "metaSampling": {},
  "metaAdapter": {
    "kind": "skill",
    "runtimeType": "codex",
    "runtimeVersion": "pinned-version",
    "runtimeIntegrity": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "harnessId": "refine",
    "harnessDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "socketPath": "/absolute/control-workspace/.gear-refine/refine.sock",
    "maxRequestBytes": 1048576
  },
  "dshBaseRef": "0000000000000000000000000000000000000000",
  "toolchainRef": "node-22-tsc",
  "sandboxProfileRef": "target-sandbox-v1",
  "seedTaskRef": "seed-dataset-ref",
  "heldOutRef": "held-out-dataset-ref",
  "taskBudgetMs": 3600000,
  "metaSandbox": { "mode": "required" },
  "candidateWorkspace": {
    "shellEnabled": false
  },
  "compiler": {
    "command": "/absolute/path/to/compiler",
    "args": [],
    "timeoutMs": 120000,
    "env": {}
  },
  "hitch": {
    "executable": "hitch",
    "harnessId": "deepseek",
    "root": "/absolute/hitch-state",
    "model": "target-model",
    "attempts": 1,
    "maxConcurrent": 4,
    "setupTimeoutMs": 1800000,
    "terminationGraceMs": 5000,
    "maxOutputBytes": 8388608,
    "maxTrajectoryOutputBytes": 67108864,
    "maxTrajectoryAnalysisBytes": 16777216,
    "maxTrajectoryEventsBytes": 4194304,
    "trajectoryCacheEntries": 8,
    "trajectoryCacheBytes": 268435456,
    "allowUnavailableVerifierDiagnosis": false,
    "sampling": {},
    "agentArgs": [],
    "passEnv": []
  },
  "initialChampion": {
    "schemaVersion": 2,
    "ref": "1111111111111111111111111111111111111111",
    "manifestDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "updatedAt": "bootstrap"
  }
}
```

未列出的数组、budget、selection 和 promotion 字段使用 `ConfigSchema` 默认值。
生产配置仍应显式固定实验相关参数，以便审阅。
示例中的 `allowUnavailableVerifierDiagnosis:true` 只适用于尚未提供 verifier evidence API 的
旧 Hitch；严格默认值为 `false`。使用支持 `hitch verifier inspect` 的 Hitch 后应删除该开关，
并重新读取 diagnostic cards，让 receipt 记录真实 verifier coverage。

启动：

```bash
gear-refine serve --config /absolute/path/to/gear-refine.json
```

server 在 stdout 输出一行 ready JSON。将其中的 `socketPath` 设置为 Meta
harness 的 `GEAR_REFINE_SOCKET`。server 收到 `SIGINT` 或 `SIGTERM` 后先关闭
skill socket，再等待 RefineService 与 active evaluation 清理完成。

## 5. Skill 工作流

Meta harness 读取 `skills/refine/SKILL.md`，通过 DSH 的 `refine_request` 或
standalone 的 `gear-refine request`：

1. `control.start` 或显式 `control.continue`；
2. 轮询 `control.status` 与 `meta.claim`；
3. 使用 exact identity 领取短期 candidate lease；
4. 通过 `candidate.tree/read/write/edit/remove` 操作受限 workspace；
5. 通过 `meta.call` 查询 seed evidence 与 trajectory；
6. 检查 authoritative diff 和固定 compiler；
7. `candidate.finalize` 或 `candidate.decline`；
8. 继续领取 sibling/next-round，直到 batch terminal。

完整方法、逐字段参数和调用顺序见
[`skills/refine/references/protocol.md`](../skills/refine/references/protocol.md)。
Meta Agent 在修改 candidate 前还必须读取
[`skills/refine/references/target-harness-editing.md`](../skills/refine/references/target-harness-editing.md)，
其中说明如何从 seed trajectory 建立因果假设、选择可编辑的 harness 资产、使用
observation digest 安全修改，以及何时 finalize 或 decline。若 candidate 是
Gear 的 DSH carrier，还必须读取
[`skills/refine/references/dsh-target-harness.md`](../skills/refine/references/dsh-target-harness.md)：
它基于锁定的 DSH `0.1.0-rc.8` 源码，说明 `preset/`、`plugins/`、`prompts/`、
`skills/`、`workflows/` 的真实加载关系、Cordis plugin 结构、skill provider
接线，以及 `tools/pre-execute` / `tools/post-execute` 等 native hook 的完整示例。

## 6. 安全边界

- local socket 所在目录为 `0700`，socket 为 `0600`；已有非-socket 路径不会
  被覆盖。
- 每个 assignment 使用 256-bit lease token，并绑定 client、session、round、
  candidate 与 workspace；过期、跨 candidate 或重放请求都会被拒绝。
- Skill API 不返回 candidate host path，只接受 `/candidate/harness` 下的逻辑
  路径。
- 只允许 `preset/`、`plugins/`、`prompts/`、`skills/`、`workflows/`；Git、
  manifest、依赖、lockfile 和其他 substrate 不可修改。
- 写入和删除要求 observation digest；创建要求 `expectedDigest: null`，防止
  stale overwrite。
- symlink、hardlink、binary/NUL、越界路径和超限文件 fail closed。
- held-out identity、trajectory 和结果不进入 Meta API；promotion 仍由 paired
  gate 和 CAS transaction 决定。
- Skill claim 返回 baseline summary 和 seed refs；每个 failed baseline run 必须
  调用 trajectory query 后才能 finalize。

External Meta harness 本身的 OS 权限由其宿主负责。Gear 不向它授予 candidate
worktree、state root 或 credential 的 host path；部署仍应让 Codex、Claude Code
或其他宿主运行在与其职责匹配的 filesystem/network sandbox 中。

## 7. DSH Skill-first 与兼容模式

`metaAdapter.kind: "skill"` 是默认值。在 DSH plugin 中，Gear 发布包内
`refine` skill；由于不再注册同名 host command，用户输入 `/refine` 会走 DSH
标准的 skill 注入路径。该 skill 优先使用 `refine_request`，由当前 DSH session
直接领取和完成 assignment；socket 同时保留给 Codex、Claude Code 或另一
兼容 harness。

只有显式设置 `metaAdapter.kind: "dsh"` 时，Gear 才创建 `DshMetaAgentHost` 并
注册旧 `/refine` command。该兼容模式要求 `metaPreset`，保留 DSH session event
attribution 和 preset isolation，但不再是默认启动方式。

## 8. 验证范围

仓库测试覆盖：

- generic Meta controller 与 DSH adapter 类型兼容；
- external identity sealing、claim、lease authorization、stale lease cleanup；
- candidate path containment、observation write/edit/remove、link 拒绝；
- local JSON socket request/error lifecycle；
- DSH 原生 skill catalog、session-bound `refine_request` 和同名 command 避让；
- 不经过 DSH Context 的 standalone control plane；
- 从 `control.start` 到 claim、trajectory diagnosis、candidate edit/check/finalize、
  seed/held-out evaluation 和 champion promotion 的完整端到端流程；
- Skill 内完整 protocol schema 与 Target Harness 编辑手册的打包、发现和校验；
- 原有 DSH plugin composition、状态恢复、evaluation repair 和 promotion 回归。
