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
npm install --global ./rsi-gear-0.1.0.tgz
```

包内包含：

- `gear-refine`：独立 server 与通用 client；
- `skills/refine/SKILL.md`：Agent Skills 入口；
- `rsi-gear`：发布同一 Skill 的 DSH plugin，并保留旧 adapter。

使用 standalone server 时，把 `skills/refine` 复制或链接到 Meta harness 的
skill 目录。不同产品的 skill 安装位置由该产品决定；不要复制一份并修改协议
或安全约束，否则它的 digest 将不再匹配 evolution identity。使用 DSH plugin
时不需要再复制：插件会以高优先级发布包内原件及其 references。

## 3. 固定 Meta identity

Skill mode 必须在启动前固定：

- runtime type，例如 `codex`、`claude-code` 或 `dsh`；
- runtime version 与 runtime artifact SHA-256；
- harness/skill id 与整个 skill 目录的资源清单 SHA-256（包括 references 和调用元数据）；
- provider、model 和 sampling。新配置省略 `maxTokens`，避免由 Gear 额外限制
  Meta 回合；旧 evolution 中已封存的值仍属于 identity。

DSH plugin 中若未填写任何 identity 字段，Gear 会从当前 DSH runtime 和包内
`skills/refine` 完整目录自动派生并封存 identity；`refine_request` 还会校验
当前作用域选中的随包 skill、会话中的原生加载记录，以及 request 的 provider、model
和 temperature，以及显式配置的 `reasoningEffort`。显式配置的 `maxTokens` 必须一致；省略时允许 DSH 标记的 adapter 默认值，
不接受其他显式上限。Standalone 或
外部 Meta harness 必须显式提供全部 identity 字段。

可通过 `metaSampling.reasoningEffort` 固定 thinking effort，例如 `medium`。
宿主负责设置实际模型请求；`meta.claim` 的 `identity.sampling.reasoningEffort`
必须与封存值一致。省略 effort 时保留宿主默认行为；更改已封存的 sampling
需要创建新 evolution。

显式配置时，`metaAdapter.runtimeIntegrity` 与 `metaAdapter.harnessDigest` 使用
`sha256:<64 lowercase hex>`。计算当前 skill bundle：

```bash
gear-refine skill-identity --path /absolute/path/to/skills/refine
```

输出是 bundle 资源清单：包含 `id`、`digest` 和每个资源的
`logicalPath`/`kind`/`digest`。它用于填写 standalone 配置中的 harness id/digest，
不是可以直接传给 `meta.claim` 的完整 identity；尤其不要把 `resources` 放进
`identity.preset`。资源按相对路径排序；总指纹是该 JSON 资源数组的 SHA-256，
不含绝对安装路径。在配置和 `meta.claim` identity 中使用同一个带
`sha256:` 前缀的 `digest` 值。Gear
会把这些字段写入 immutable `EvolutionSpec`；claim、continue 和恢复时不匹配
都会 fail closed。

Standalone core 启动后，使用只读 `control.identity` 生成 canonical identity。
它把完整 `MetaAgentSpec` 投影为 runtime、preset id/digest、model 和显式
`sampling` 对象；spec-only 的 `preset.resources` 与 `contextOffloading` 不进入
结果。外部 identity 文件按这个窄 schema 严格解析，任何层级的未知字段都会被
拒绝，不会静默删除。自定义 Node runner 可从 `rsi-gear/skill` 导入
`parseSkillHarnessIdentity` 和 `assertSkillHarnessIdentityMatches`，避免复制一份
不完整的校验器。

旧版仅封存 `SKILL.md` 的 evolution 不会自动迁移到新指纹；升级后应创建新 evolution，
不要修改旧实验 identity。Native bridge 会拒绝启动后发生的 bundle 内容变化。

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

## 5. Codex Node runner 的最小操作顺序

外部 Codex 使用版本化 Node stdio MCP transport
`skills/refine/scripts/transport.mjs`，生产入口是
`examples/codex-skill-meta-runner.mjs`。runner 只连接已运行的 Gear Core；
它不启动或停止 core。先在一个独立终端启动上一节的 `gear-refine serve`，
并在整个 round 期间保持该进程运行。

Codex 凭据使用一个独立、持久且 owner-only 的 home。该目录跨 assignment
复用，由 Codex 自己创建和更新其中的认证文件；runner 不从其他 home 复制
`auth.json`，也不为每个 attempt 制作凭据副本。为 runner 设置下面这一套环境。
所有路径都必须是绝对路径；identity 文件包含与 Gear 配置完全一致的 runtime、
随包 skill digest、model 和 sampling。即使没有 sampling override，也必须保留
`"sampling": {}`：

```bash
export GEAR_REFINE_SOCKET=/absolute/control-workspace/.gear-refine/refine.sock
export GEAR_REFINE_IDENTITY_FILE=/absolute/private/meta-identity.json
export GEAR_META_CODEX_HOME=/absolute/private/gear-meta-codex-home
export GEAR_META_RUN_ROOT=/absolute/private/gear-meta-runs
export GEAR_META_WORKSPACE=/absolute/meta-workspace
# Optional; defaults to codex from PATH.
export GEAR_CODEX_EXECUTABLE=/absolute/path/to/codex

install -d -m 0700 "$GEAR_META_CODEX_HOME" "$GEAR_META_RUN_ROOT" \
  "$(dirname "$GEAR_REFINE_IDENTITY_FILE")"
umask 077
gear-refine request control.identity '{}' > "$GEAR_REFINE_IDENTITY_FILE"
# 首次部署时由 Codex 在持久 home 内创建认证；
# 后续不要为每个 attempt 重复登录。
CODEX_HOME="$GEAR_META_CODEX_HOME" "$GEAR_CODEX_EXECUTABLE" login
node examples/codex-skill-meta-runner.mjs --preflight
```

无 `evolutionId` 的 `control.identity` 与 `--preflight` 都针对 core 当前配置，
所以这一步必须在 `control.start` 前成功。runner 验证 Codex 版本和该持久 home
的登录状态，启动一次 transport 探针，并通过 MCP 调用 `control.identity` 后逐字段
比较本地文件。随后它启动一个短暂的 Codex 会话，在 Gear MCP 中仅暴露
`read_refine_resource`，并要求 JSONL 事件证明模型已通过 Gear MCP 成功读取
`SKILL.md`；模型输出 ready 文本或仅以零状态退出都不算成功。两项探针都不会创建
evolution、调用 evaluator 或领取 lease，也不会调用 `meta.claim`。

每次 preflight 都会增加一次短 Codex 会话和模型探针，一次会话可能包含多轮模型
请求。正式的 round 命令会自行再次运行 preflight；即使之前单独运行过
`--preflight`，也不会复用或缓存结果，因此调度时需要计入这段延迟和模型用量。
Codex 仍使用 `approval_policy=never`；runner 只对受控 Gear MCP 的
`read_refine_resource` 与 `refine_request` 设置逐工具授权，且 preflight 的 Gear MCP
工具列表只包含前者。不要用一次失败的 preflight 结果继续实验。

随后创建 evolution：

```bash
ADMISSION="$(gear-refine request control.start '{"rounds":1}')"

EVOLUTION_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).evolutionId)' "$ADMISSION")"
ROUND_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).roundId)' "$ADMISSION")"

node examples/codex-skill-meta-runner.mjs --evolution-id "$EVOLUTION_ID" --round-id "$ROUND_ID"
```

继续已有 evolution 时，先从 sealed spec 重新生成 identity，并把同一个 id 传给
preflight；这样当前 core 配置已变化时，仍会针对即将继续的不可变配置检查。只有
这一步成功后才调用 `control.continue`：

```bash
gear-refine request control.identity \
  "{\"evolutionId\":\"$EXISTING_EVOLUTION_ID\"}" > "$GEAR_REFINE_IDENTITY_FILE"
node examples/codex-skill-meta-runner.mjs --preflight \
  --evolution-id "$EXISTING_EVOLUTION_ID"
ADMISSION="$(gear-refine request control.continue \
  "{\"evolutionId\":\"$EXISTING_EVOLUTION_ID\",\"rounds\":1}")"
EVOLUTION_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).evolutionId)' "$ADMISSION")"
ROUND_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).roundId)' "$ADMISSION")"
node examples/codex-skill-meta-runner.mjs --evolution-id "$EVOLUTION_ID" --round-id "$ROUND_ID"
```

若要让已完成 seed selection 的可恢复失败 round 从 held-out evaluation 继续，传入它的精确 `roundId`：

```bash
ADMISSION="$(gear-refine request control.continue \
  "{\"evolutionId\":\"$EXISTING_EVOLUTION_ID\",\"roundId\":\"$EXISTING_ROUND_ID\"}")"
```

这种形式继续原 round，并保留它的 batch/round identity 和 durable state；`roundId`
不能与新 batch 使用的 `rounds` 或 `focus` 同时提交。恢复中的 round 不创建 Meta
assignment，也不需要 Meta runner；先轮询该 round 的 `control.status`。它正常结算后，
Gear 沿用原 `batchId`、`roundCount` 和 focus 创建尚未完成的普通 rounds；外部
Skill-first runner 应按正常的 claim/candidate 流程继续处理这些新 assignment，直到
batch terminal。已有 Gear 持有的 failed evaluation 使用 `control.rerun`；只有 selected
candidate 的 held-out evaluation 没有 execution trace 时才会启动缺失的 run。

一次 runner 调用至多处理一个 assignment；当前跟踪的实验配置也固定
`candidateGeneration.maxCandidates: 1`。assignment 持久化结算后 runner
退出，stdout 返回当前 round status；`failed` 返回非零状态，合法的 accepted
decline/rejected 保持成功退出。若 round 仍非终态，外层调度器先读取同一
`evolutionId`/`roundId` 的 `control.status`，再调用同一条 runner 命令处理
下一个 sibling 或恢复后的 assignment。不要通过启动另一个 core 来推进它。

```bash
gear-refine request control.status "{\"evolutionId\":\"$EVOLUTION_ID\",\"roundId\":\"$ROUND_ID\"}"
node examples/codex-skill-meta-runner.mjs --evolution-id "$EVOLUTION_ID" --round-id "$ROUND_ID"
```

Codex 进程异常、正常退出但没有获得 `accepted:true`，以及
`accepted:false,recoverable:false` 都属于未完成 assignment。runner 从私有
session 读取 lease，并调用 supervisor-only `meta.fail(reason)`；该调用在
generation attempt 和 round 已持久化为 `failed` 后才成功。若 status 表明该
attempt 已由 accepted finalization 或其他路径结算，runner 把迟到的 fail 当作
已处理，不会覆盖结果。

每个 assignment 的 run 目录为 `0700`，`session.json`、Codex event/stderr
文件和 transport audit 为 `0600`。`leaseToken` 只存在于私有 session 和发往
core 的鉴权 envelope；模型响应、transport audit、runner 日志和报告均不得记录
token。audit 仅记录 assignment 关联、method/capability 以及
`accepted`/`recoverable`/`code`。

## 6. Skill 工作流

Meta harness 读取 `skills/refine/SKILL.md`，通过 DSH 的 `refine_request` 或
standalone 的 `gear-refine request`：

1. `control.start` 或不带 `roundId`、创建新 batch 的 `control.continue`；
2. 轮询 `control.status` 与 `meta.claim`；
3. 使用 exact identity 领取短期 candidate lease；
4. 通过 `candidate.tree/read/write/edit/remove` 操作受限 workspace；
5. 通过 `meta.call` 查询 seed evidence 与 trajectory；
6. 检查 authoritative diff 和固定 compiler；
7. `candidate.finalize` 或 `candidate.decline`；
8. 继续领取 sibling/next-round，直到 batch terminal。

带 `roundId` 的 `control.continue` 是 operator recovery 入口：先轮询恢复 round 的
`control.status`，该 round 不执行上述 Meta claim/candidate 步骤。若 Gear 随后创建原
batch 的下一个普通 round，则继续执行步骤 2–8，直到 batch terminal。

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

## 7. 安全边界

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

Skill 模式的 Meta harness（包括当前会话中的 native DSH）本身的 OS 权限由其宿主负责。
原生加载记录验证只证明该 session 加载过随包 skill，并不证明其他 persona、历史、
工具或权限未变化；socket 客户端的 identity 仍是受信本地客户端的声明，不是远程证明。
Gear 不向它授予 candidate
worktree、state root 或 credential 的 host path；部署仍应让 Codex、Claude Code
或其他宿主运行在与其职责匹配的 filesystem/network sandbox 中。

## 8. DSH Skill-first 与兼容模式

`metaAdapter.kind: "skill"` 是默认值。在 DSH plugin 中，Gear 发布包内
`refine` skill；由于不再注册同名 host command，用户输入 `/refine` 会走 DSH
标准的 skill 注入路径。该 skill 优先使用 `refine_request`，由当前 DSH session
直接领取和完成 assignment；socket 同时保留给 Codex、Claude Code 或另一
兼容 harness。

若压缩历史移除了 skill 加载记录，需通过原生 skill 工具重新加载；Code Mode 中先
完成加载调用，再单独调用 `refine_request`。用户粘贴的 skill 文本不能替代原生加载记录。

只有显式设置 `metaAdapter.kind: "dsh"` 时，Gear 才创建 `DshMetaAgentHost` 并
注册旧 `/refine` command。该兼容模式要求 `metaPreset`，保留 DSH session event
attribution 和 preset isolation，但不再是默认启动方式。

## 9. 验证范围

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
