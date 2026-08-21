# Gear ↔ Hitch CLI 集成设计

- 状态：Draft v0.5
- 目的：用已安装的 Hitch CLI 完成 TargetHarness 的版本解析、Harbor 评测和证据记录
- 基线：agent-hitch `dev@8c034d9`，DeepSeek Harness headless
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

## 3. Gear 只调用 Hitch CLI

推荐调用形式：

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

Gear：

1. 通过配置的 executable或 `PATH` 查找 `hitch`；
2. 启动前可调用 `hitch --version` 和 `hitch eval doctor --json`；
3. 每次 eval 使用独立 argv，不经过 shell；
4. 从 stdout读取单个 JSON result，stderr只作 bounded diagnostic；
5. 转发 abort为 SIGTERM，超时后按固定 grace period升级终止；
6. 校验 CLI exit code、`status`、`eval_id`、resolved commit、trial counts和 `summary.primary_reward`；
7. round record只保存 Hitch返回的eval/ref和Gear自己的decision，不修改 Hitch records。

不要求 Hitch Node exports、daemon或Gear专用plugin ABI。daemon以后可作为性能优化，但不是V1正确性前提。

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
