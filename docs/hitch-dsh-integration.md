# Gear ↔ Hitch CLI / daemon 集成设计

- 状态：Draft v0.6
- 目的：用已安装的 Hitch CLI 完成 TargetHarness 的版本解析、Harbor 评测和证据记录
- 基线：agent-hitch `0.2.6`，DeepSeek Harness headless
- 更新：2026-08-21 — 删除 `dsh-evolving` adapter、`dsh-eval-runner`、Hitch Node API 和独立 overlay identity；V1 直接复用 Hitch 现有 `deepseek` adapter，每个 TargetHarness 版本是一个完整 DSH source repo 的 exact Git commit；Hitch 唯一缺口是把 local exact commit 运输进 Harbor。

## 1. 决策

V1 采用最小链路：

```text
Meta 修改 TargetHarness
  -> Gear 在专用 DSH source repo/worktree 创建 exact commit H1
  -> Gear 调用已安装的 hitch CLI
  -> Hitch 用现有 deepseek adapter prepare H1
  -> Harbor 中运行 DSH headless
  -> Hitch 返回 eval JSON/reward
  -> Gear 比较 H0/H1 并移动 champion pointer
```

Hitch 是 Harness version control 和执行记录层，不是 Gear 的内嵌库。Gear 不 deep-import `agent-hitch/dist/src/*`，不复制 Hitch resolver、artifact cache、Harbor backend 或 daemon。部署通过 npm 安装 Hitch，Gear只发现并启动 `hitch` executable，使用版本化 JSON/JSONL CLI 合同。

## 2. 唯一版本身份

### 2.1 Candidate repo

TargetHarness candidate 位于一个完整、可由现有 `deepseek` adapter 构建的 DSH source repo 中。repo 基于固定 `dshBaseRef`；Gear 的 mutation validator 只允许修改 TargetHarness 的 allowlisted prompt、skill、plugin、workflow 和 composition 路径，不允许修改 DSH core、Hitch、Harbor、模型、sandbox 或 evaluator。

```text
DSH source repo
  apps/cli/...
  packages/...
  harness/
    manifest.json
    preset/
    plugins/
    prompts/
    skills/
    workflows/
```

repo 必须让其 shipped headless profile/composition加载同一 commit 中的 TargetHarness。现有 `deepseek` adapter 继续执行其标准 commit recipe：checkout、install/build、运行 `dsh --profile headless <task>`。

### 2.2 `TargetHarnessRef`

V1 的 `TargetHarnessRef` 是完整 Git commit OID：

```text
H0 = current champion commit
H1 = candidate commit derived from H0
```

Git commit 是 Gear、Hitch、round record 和 champion pointer 共用的唯一版本主键。`harness/manifest.json` 仍可包含文件 digest、`dshBaseRef`、toolchain 和 sandbox声明，用于构建校验和运行时 preset id；它不再产生第二套可 promotion 的 Harness identity。

Gear 在创建 H1 前对 H0 做 parent CAS，应用 mutation、运行固定检查并创建 commit。Hitch随后解析和 prepare这个 exact commit。promotion只把 champion从H0移动到已经成功评测的H1。

## 3. Gear 只调用 Hitch 的公开 CLI

Gear 不导入 Hitch 内部模块。默认 `hitch.controlPlane.mode: direct` 使用直接 CLI：

```bash
hitch eval run \
  --backend harbor \
  --dataset <seed-or-held-out-dataset> \
  --harness 'deepseek@git+file:///absolute/path/to/dsh-repo#<full-commit>' \
  --model <fixed-model> \
  --attempts 1 \
  --max-concurrent <n> \
  --timeout <duration> \
  --setup-timeout <duration> \
  --output json
```

需要让 eval 与其他 Hitch 工作共享持久化队列和资源预算时，配置 `hitch.controlPlane.mode: daemon`。Gear 先用确定性幂等键预留服务端身份，再等待同一 eval：

```bash
hitch --root <state-root> eval submit \
  --idempotency-key <gear-derived-key> \
  --backend harbor \
  --dataset <dataset> \
  --harness 'deepseek@git+file:///absolute/path/to/dsh-repo#<full-commit>' \
  --model <fixed-model> \
  --attempts 1 \
  --max-concurrent <n> \
  --timeout <duration> \
  --setup-timeout <duration>

hitch --root <state-root> eval watch <server-eval-id> --output json
```

取消时 Gear 终止本地 watch 后调用 `eval cancel`；修复时调用 `eval rerun ... --type candidate-restart --daemon`。daemon 的总资源容量由 `hitch daemon start` 管理，Gear 可在 submission 中固定 provider、每 trial CPU/内存、build mode 和 model-capture policy。

Gear：

1. 通过配置的 executable或 `PATH` 查找 `hitch`；
2. 启动前调用 `hitch --version`；daemon 模式还调用同一 root 的 `daemon status --json` 并要求状态为 `running`；
3. 每次 eval 使用独立 argv，不经过 shell；
4. 从 stdout读取单个 JSON result，stderr只作 bounded diagnostic；
5. direct 模式转发 abort 为 SIGTERM，超时后按固定 grace period升级终止；daemon 模式同时发送持久化 cancellation；
6. 校验 CLI exit code、`status`、`eval_id`、resolved commit、trial counts和 `summary.primary_reward`；
7. daemon 模式从 inspection 校验 submission request、幂等键 hash 和冻结 execution policy，并把实际 policy 纳入 baseline/candidate 的语义配置身份 `effectiveConfigDigest`；
8. round record只保存 Hitch返回的eval/ref和Gear自己的decision，不修改 Hitch records。

daemon 提交前，Gear 先在 round 的 `pendingEvaluationSubmissions` 保存归属、评测请求、幂等键和固定 CLI 参数，然后才执行 `eval submit`。返回的 eval ID 与 attempt 归属一并落盘。提交阶段接收 round 的取消信号；即使响应丢失或 ID 写入失败，Gear 仍可使用持久化意图恢复同一任务并取消它。

启动恢复会处理未完成的提交，包括已经标记为失败的 round。Gear 先重放原幂等键；如果默认资源策略或执行容量变化导致重放被拒绝，则通过 `eval list` / `eval inspect` 查找匹配的 `idempotency_key_hash`。恢复出的任务会被取消，而不是继续执行中断的 round。只有评测结束或 daemon 持久接受取消后，Gear 才移除待处理意图；清理失败会保留意图，供下次启动重试。

提交后的 watch、JSON 解析、运行时校验、inspection 和 rerun 异常都会触发独立且有时限的取消。取消失败保留原始错误的 code、message 和 cause，并单独记录 `cleanupFailure`；状态接口通过 `evaluationCleanupFailures` 暴露待处理的清理错误码。

不要求 Hitch Node exports 或 Gear 专用 plugin ABI。direct 与 daemon 都经过同一个 CLI JSON 合同；direct 要求 agent-hitch 0.2.5+，daemon 要求 0.2.6+。

direct 模式可按语义配置身份复用跨轮次 baseline。daemon 的默认执行策略在提交后才冻结，当前不预先声明可复用身份；已有该版本的 baseline 时明确阻塞，不能通过重新提交评测来探测执行策略。

### 3.1 Python 运行环境

Gear 启动 Hitch CLI 子进程时固定 `PYTHONDONTWRITEBYTECODE=1`。这会保护由当前 Gear 进程启动的 direct `eval run` 和 direct `eval rerun`，避免 Hitch immutable controller runtime 中的 Python bridge 写入 `.pyc`。它不会改变已经运行的 Hitch daemon 或 remote worker 环境；这些路径仍需 Hitch 自身修复。

该开关不会直接修复已经含 `.pyc` 的 CAS runtime，按原 runtime ID 的 rerun 仍会拒绝。不要由 Gear 清理或手工改写 CAS；使用 Hitch 支持的隔离和重建流程并保留原证据，或部署包含根修复的 Hitch 后构建新 runtime。只有 Hitch runtime 内容变化才会产生新的 runtime ID，Gear 的这项防护不会改变 Hitch CAS 身份。

## 4. Baseline、candidate与held-out

Gear分别调用Hitch，不要求Hitch提供“对比两个candidate”的新命令：

```text
seed baseline:      eval(H0, seed)
wake meta
seed candidate:     eval(H1, seed)
held-out baseline:  eval(H0, held-out)
held-out candidate: eval(H1, held-out)
```

四次调用使用相同的dataset materialization规则、model、attempts、timeout、setup timeout、concurrency和固定agent args；有意差异只有commit和seed/held-out partition。held-out eval只在proposal产生后由RefineService发起，其refs和aggregate不进入meta projection。

追加轮次和同批次的后续轮次复用同一个 exact commit 已 settled 且至少含一个有效 trial 的 seed / held-out 结果，包括其晋升前作为 candidate 的 complete 或 partial 评测。复用保留原始 completeness、eval ID、trial/run ID 和评分，不改写来源记录；优先查找当前 champion 的晋升轮次，然后按稳定历史顺序查找。后续比较仍只使用双方有效 trial 的交集；零分但有效的 trial 可复用。

自动续轮和手动追加创建的新 round 都以当前 champion 为唯一代码父版本，并在 `championParent` 中保存其身份和研究上下文来源。seed-selected survivors 仍写入 research population，保留评分、谱系和研究记录，但未晋升候选不再成为下一轮工作区的父版本，也不会因为自己的 partial 评测要求另跑 parent baseline。冠军即使已经不在 research population 中，也从其晋升历史恢复父版本元数据。

新候选的 Meta checkpoint 来自该 champion 的晋升候选；初始 champion 使用初始 Meta root。历史候选的研究记录继续保留，不把未晋升候选的代码上下文或诊断凭据冒充为当前冠军的基线。新 round 的父快照、工作区父 commit 和 baseline 归属保持一致。升级前已经封存的 round 仍按原父版本和 checkpoint 恢复，不改写其历史决策或已有执行。

只有该 commit / partition 从未留下评测证据、执行开始记录、attempt 或待确认的提交，才自动启动新 baseline。已有结果无法复用时，round 进入 `failed`，`control.status` 的 `baselineReuseBlocker` 给出原因和恢复要求：

- `BASELINE_IDENTITY_UNRESOLVED`：无法在执行前确认身份，例如当前 daemon 接口不能预先解析冻结后的执行策略；不会通过 submit 来探测身份。
- `BASELINE_CONDITION_MISMATCH`：数据集、评分合同或有效配置不兼容；需要恢复兼容条件，或明确创建新 evolution。
- `BASELINE_EVIDENCE_UNAVAILABLE`：已有未 settled（包括 failed attempt）或零有效 trial 的评测，或缺少可验证的来源证据；保留原有证据，不能通过追加轮次触发全量重跑。已 settled 且仍含有效 trial 的 partial 证据可以原样复用。

Direct 模式下，标准 benchmark 不再一律禁用复用；Gear 验证冻结的数据集完整目录（包含 adapter / scoring manifest）未变，再核对已有证据的有效配置。相对数据集路径按 evolution 的 workspace root 解析，与 Hitch 执行路径一致。旧实验若曾按错误工作目录封存了 opaque digest，会明确拒绝继续，不改写旧 spec 或 evidence。

这项修复不增加 provider 的 partial 补齐接口、通用 pause/resume 或旧实验迁移机制。调用 provider 前先持久化执行开始记录，即使 provider 不支持预留 eval ID 或在返回 ID 前失败，后续轮次也不能将其误判为从未执行。已有失败评测的显式 rerun 修复入口继续保留；修复启动时清除旧阻塞诊断，恢复后重新校验 baseline；partial 的自动补齐需要 provider 能保证保留有效 trial 的独立支持。

V1 promotion使用Harbor dataset verifier返回的reward。action verifier仍可属于TargetHarness并帮助agent自纠，但不能修改Harbor reward或Gear promotion policy。

## 5. Hitch 已交付：local exact commit进入Harbor

Hitch本地resolve/prepare/run与Harbor eval现在都接受：

```text
deepseek@git+file:///repo#<commit>
```

`dev@8c034d9`已经把host解析的exact commit打成可验证object pack，在trial中恢复同一commit，并让现有deepseek prepare/run消费host锁定的resolution。Gear因此不需要push rejected candidate，也不需要任何Hitch内部API。

这项改动：

- 不新增adapter；
- 不新增overlay store或第二个HarnessRef；
- 不改变deepseek process contract；
- 不要求Gear推送未接受candidate；
- 不让container从host path或registered remote重新解析candidate；
- bundle/archive digest只验证运输，不替代Git commit identity。

完整开发合同见 [Hitch local exact commit → Harbor transport 开发需求](hitch-local-commit-harbor-requirements.md)。

## 6. 职责边界

| 层 | 权威职责 |
| --- | --- |
| Gear / RefineService | mutation、创建candidate commit、选择baseline/candidate、held-out隔离、比较reward、promotion/rollback |
| Hitch CLI | resolve exact commit、prepare immutable artifact、run/eval supervision、Harbor orchestration、eval/run records |
| DSH headless | 创建Agent/session、执行TargetHarness、持久化原生session log、输出最终结果 |
| Harbor | disposable trial环境、task materialization、dataset verifier和reward |

DSH原生session log是agent trajectory事实来源。V1不要求Hitch重新实现一套DSH event协议；Hitch现有trajectory/result记录可用于诊断。若native log没有从ephemeral Harbor trial导出，Gear/meta只能使用Hitch现有final output、eval summary和reward，不能假装已经拥有完整轨迹。完整native DSH日志导出、workspace snapshot、独立verifier sidecar和逐event attribution都属于后续增强，不阻塞“version → run → score → promote”。

## 7. 最小失败规则

以下任一情况使本次comparison不可用于promotion，并由Gear将round记为`failed`：

- Hitch CLI无法启动、被取消或非零退出；
- result JSON缺失、无法解析、schema不支持或 `status !== "succeeded"`；
- actual resolved commit与请求的full commit不一致；
- Harbor没有result，存在errored/cancelled required trial，或primary reward缺失/非有限数；
- local source transport、commit/tree校验或prepare失败；
- parent champion CAS在promotion前失效。

正常完成但reward较低是candidate结果，进入`rejected`；不能把基础设施失败伪装成零分candidate。

## 8. V1明确不做

- 新增 `dsh-evolving` Hitch adapter；
- 新增 `dsh-eval-runner` 或要求DSH SDK server支持评测专用协议；
- 让Gear import Hitch内部TypeScript模块；
- 创建overlay identity、artifact identity与Git commit并行的多套promotion主键；
- 要求interactive TargetWorker和headless rollout拥有逐event相同的transport；
- 将full native trajectory、workspace snapshot或独立verifier sidecar设为promotion前置；
- 让Hitch承担meta、mutation、baseline/candidate比较或promotion。

## 9. 实施顺序

1. ~~Gear HarnessBuilder迁移为基于固定DSH base repo创建candidate commit，`TargetHarnessRef = full commit`。~~ 已在当前 Gear `dev` worktree实现，并用 `refs/dsh-refine/candidates/<commit>`保持commit可达。
2. ~~Hitch实现local exact commit → Harbor transport，并保持现有remote/version eval回归通过。~~ 已由 `8c034d9` 交付。
3. ~~Gear实现CLI-backed `RefineEvaluator`，分别运行H0/H1和seed/held-out。~~ 已在当前 Gear `dev` worktree实现；包含JSON/commit/transport校验、parity fingerprint、取消与输出上限。
4. 端到端验证：Meta只改一个TargetHarness文件，H1未推远端也能在Harbor通过现有deepseek adapter运行；Hitch result中的commit等于H1；Gear可拒绝或promotion。

## 10. 参考

- [主 spec](dsh-self-evolving-harness-spec.md)
- [Hitch transport开发需求](hitch-local-commit-harbor-requirements.md)
- [Hitch adapters](../../agent-hitch/src/adapters.ts)
- [Hitch eval guards](../../agent-hitch/src/evals.ts)
- [Hitch resolution/artifacts](../../agent-hitch/src/artifacts.ts)
- [Hitch Harbor backend](../../agent-hitch/src/harbor-backend.ts)
- [Hitch Harbor agent](../../agent-hitch/integrations/harbor/hitch_harbor_agent.py)
- [DSH headless runner](../deepseek-harness/packages/bundle/headless/src/index.ts)

### Daemon rerun 的独立生命周期

Gear 在调用 `hitch eval rerun --daemon --rerun-id <id>` 前，将独立的
`rerunId`、源 `evalId` 和原始 Hitch root 原子写入 `pendingEvaluationRerun`。
观察失败、进程中止、证据持久化失败以及 Gear 重启，都使用
`hitch eval rerun-cancel <eval-id> <rerun-id>` 清理这次修复。源 eval 的
`eval cancel` 不会取消 rerun，不能用它代替。

取消接口必须在 rerun 执行和资源释放完成后才确认成功，并持久化该 ID 的取消记录，
阻止迟到的提交启动。取消失败时保留 pending identity，状态中暴露独立的清理错误，
启动时重试同一 ID；完成清理前不接受新的 repair。若 Hitch 自身重启后返回
`execution_state_ambiguous`，Gear 保留归属，不能将其当作已停止。

这条路径要求 Hitch 同时提供 `--rerun-id` 和 `eval rerun-cancel` 合同；
不支持该合同的 CLI/daemon 会拒绝操作，不会退回旧的 daemon rerun 命令。
CI 的 `Hitch rerun contract` job 固定 Hitch 实现提交，运行真实 CLI、HTTP 路由和
调度器联动测试；本地可构建同一 Hitch 提交后运行：

```sh
HITCH_CONTRACT_ROOT=/path/to/agent-hitch npm test -- tests/integration/hitch-rerun-contract.spec.ts
```

配套实现：[agent-hitch PR #15](https://github.com/rsi-gear/agent-hitch/pull/15)，
合同测试固定提交 `90d4cc3a5d98df53b02e57b54762e16ac1c6d942`。
启用 daemon rerun 前需安装包含该实现的 Hitch。
