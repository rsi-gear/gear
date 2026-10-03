# Python 四阶段与 AgentRunner

如果你只想写四个普通 Python 阶段然后运行，从 [TrainingLoop 开发指南](development.zh-CN.md) 开始。本文说明现有 Slime 在线 RL 后端内部的阶段与可选 agent 接入。各算法及离线 SFT 的公共四阶段组合见开发指南。

训练的逻辑链路为 `TaskSource → RolloutExecutor → DatasetBuilder → ModelUpdater`。默认实现分别是冻结任务游标、现有 Hitch rollout、严格 GRPO 样本构建和 Slime 更新。driver 继续负责 checkpoint、HF export、pending-update 和提交恢复；TypeScript 继续负责实验、独立评估、晋升和发布。这四步没有成为四个服务。

原始轨迹、反馈和训练样本分开保存。失败、截断或 verifier 拒绝的证据可以留在 CAS，而不进入梯度样本。无 agent 配置时保持原有任务游标、组重采样、有效零奖励、原生 token/logprob 与 sealed batch 重放行为。

## 本地 agent 与远端训练

可选 agent 阶段只用于 schemaVersion=2。Codex 在 controller 的 `hitch.python` 环境运行，可以位于 Mac；Slime 在冻结的模型节点运行。节点通过现有认证 RPC `training.stages.list/inputs/result` 请求 controller 工作，无新增网络服务。`advance` 启动后台 Python stage worker，随后返回，调用方仍须持续协调以维护 controller contact 和服务租约。

controller Python 安装可选 SDK：

```sh
python -m pip install '/path/to/gear/python[agents]'
```

首个适配器使用官方 `openai-codex==0.159.3` Python SDK（[官方 SDK 文档](https://learn.chatgpt.com/docs/codex-sdk)），线程固定 stage workspace，使用 `workspace_write` 和 `deny_all` approval mode。沿用该 controller 环境的 Codex 身份认证。GPU 节点不需要 SDK。提供方的命令执行能力仍遵循其 sandbox；输入封存检查及 split 验证发生在 Gear 的阶段边界。

## 添加可运行的配置

先按 [v2 controller 指南](controller-v2.zh-CN.md) 准备真实有效的 `spec.json` 和 `controller.json`。下面脚本把指令存入 controller CAS，生成 `spec-agent.json`；不会填写伪造模型、数据集或运行时摘要。

```sh
python - <<'PYTHON'
import json
from pathlib import Path
from gear_training.content import ContentStore
controller = json.loads(Path('controller.json').read_text())
spec = json.loads(Path('spec.json').read_text())
assert spec['schemaVersion'] == 2
store = ContentStore(controller['storeRoot'])
def stage(instructions):
    return {'runner': 'codex', 'options': {'model': 'gpt-6.1-sol', 'effort': 'high'},
            'instructionsRef': store.put_bytes(instructions.encode(), 'text/plain'),
            'maxRepairs': 1, 'timeoutSeconds': 120}
spec['stages'] = {
  'taskSource': stage('Read inputs/index.json, task directories and permitted history. '
    'Generate between 1 and maxTasks Harbor tasks to exercise current weaknesses. '
    'Write outputs/manifest.json with tasks, each containing id, family, directory, sourceTaskId. '
    'Use unique new IDs, retain the source training family, and create matching task.toml and instruction.md files.'),
  'datasetBuilder': stage('Inspect the native trajectories and feedback. '
    'Write outputs/manifest.json with selectedEpisodeIds and analysis. '
    'Keep all episode IDs in their original order, or reject the entire group with []. '
    'Do not create or change rewards, token IDs, logprobs or verifier evidence.')
}
Path('spec-agent.json').write_text(json.dumps(spec, indent=2))
PYTHON
gear-refine training validate spec-agent.json --config controller.json
gear-refine training init spec-agent.json --config controller.json
gear-refine training admit EXP_ID --config controller.json
gear-refine training preflight EXP_ID RUN_ID --config controller.json
gear-refine training advance EXP_ID RUN_ID --config controller.json
```

替换实际返回的 `EXP_ID`、`RUN_ID`，重复 `advance` 到完成或明确失败。两项 stage 可独立省略。改变 bridge 或冻结运行时后需要重新验证；旧认证不是此次改动的 GPU 认证。每轮当前 behavior 权重身份进入 task-source 输入，最多 64 条已允许的训练历史提供原始请求、响应、native token/logprob 文件。历史按持久记录的确定顺序限量；不保证时间排序。当前轮的输入快照首次执行时冻结，部分 rollout 后恢复不会追加历史并重新生成任务。

TaskSource 的输出示例：

```json
{"tasks":[{"id":"generated-001","family":"existing-train-family","directory":"generated-001","sourceTaskId":"existing-train-task-id"}]}
```

`outputs/generated-001/` 必须包含有效 Harbor 任务内容。controller 先 snapshot、验证、封存，再复制到可信 dispatch 目录。生成任务不能碰撞 dev/held-out 的 ID、family、快照内容、文件内容指纹或 instruction；这些私有分区内容不会送入 agent。生成任务记录源任务环境引用作为来源，实际生成环境由封存任务与 canonical 执行证据绑定；来源引用校验不证明生成 Dockerfile/task.toml 完全继承源环境策略。实际 native taskDigest/verifier identity 在封存任务实际执行后，从 canonical Hitch 证据核对并记录；不预先伪造未知的 workspace 摘要。

DatasetBuilder 输出示例：

```json
{"selectedEpisodeIds":["episode-a","episode-b"],"analysis":"The complete ordered group has usable evidence."}
```

GRPO 只支持整组保留或整组拒绝；不支持按 episode 成功筛选一个组。agent 的分析和选择是辅助数据，trusted builder 从原始 receipts 组装训练样本。

## 通用 runner 与恢复

公共接口是 `gear_training.agents.AgentRunner`。runner 接收 `AgentRequest(workspace, instructions, timeout_seconds, recovery_id)`，返回 `AgentResult(status, artifacts, log, recovery_id)`。阶段负责领域校验及封存，runner 不需要了解训练。

另一个提供方可以实现此接口，并在 controller 的环境中设置 `GEAR_AGENT_RUNNER_FACTORY=installed_module:factory`。factory 接收 `(provider_name, options)`，返回 runner；spec 的 `runner` 是任意提供方名称，`options` 是该适配器的 JSON 配置。此 factory 是运营端安装配置，不由任务输出指定。Claude Code、DSH 尚无内置实现；增加适配器不需要改训练 TS schema。直接 Python 调用也可以向 `run_agent_stage(..., runner=runner)` 注入实现，不要求安装 Codex SDK。

每个逻辑阶段绑定 run、轮次、输入摘要、指令/config 和 behavior 权重。已验证 result 连同 inputRef、输出快照及日志持久化；重试验证并重放这些对象，不重跑 agent。SDK native thread ID 在推理前写盘，未完成的执行可恢复线程。输出错误进入最多 3 次、配置有界的修复；超时、失联和基础设施失败与模型/verifier 失败分开。基础设施失败需要原训练作业显式恢复的新租约；不能静默反复创建 agent。

worker 启动前取消也先写持久 cancel 标记。关闭/过期租约拒绝迟到结果；已有生成任务的授权仍用于取消和清理。PID 与创建时间识别 worker/子进程，默认暂停流程不等待完整 agent turn。agent 执行期间原有总体 wall/GPU 预算仍生效，模型服务租约保持占用。

controller workspace 和 CAS 必须持久化：缓存授权与续跑读取原 controller 状态，本实现没有承诺丢失 controller 磁盘后自动重建。input/output workspace 复用 schemaVersion=2 `harbor-dataset` 快照以保留权限与空目录。单阶段输出最多 4096 项、64 MiB；上传只处理验证过的文件，JSON 文件作为原始文件，不追踪其中可能出现的 CAS refs。原 v2 冻结任务仍留 controller；明确选择 agent 生成时，其新输出与任务快照文件上传模型节点用于候选制品的可追溯归档，任务仍由 controller 执行。inputRef 记录模型摘要而不追踪模型权重字节。

## 身份与 SFT 数据

`behaviorPolicyRef` 表示轨迹生产策略，`updateStart` 区分完整 optimizer/scheduler/RNG 恢复与显式初始权重冷启动。`referenceModelRef` 由需要它的目标使用；当前 GRPO schema 仍要求此字段必填。当前 Slime GRPO 仍严格 on-policy：不能把任意其他策略的轨迹或任意初始 checkpoint 当作已支持的更新方式。旧配置保留已有默认值。

`stages.SFTDatasetBuilder` 是独立的成功解/已验证前缀提取器，仅输出 `sft-dataset` 中间产物；它不直接输出 `offline-sft-v1` 所需的封存数据合同。内置 SFT 更新已由 `gear_training.offline_sft` 四阶段组合和 Slime updater 支持，使用前按 [配方指南](recipes.zh-CN.md) 编码、绑定 train 来源并封存数据。前缀提取器的调用示例：

```python
from gear_training.stages import SFTDatasetBuilder
# raws 是持久化 RawTrajectory；proofs 由可信 verifier 提供，值为 CAS ref。
dataset_ref = await SFTDatasetBuilder(store).build(raws, verifications=proofs)
```

proof 必须包含 `kind`（`verified-success` 或 `verified-prefix`）、`episodeId`、`runId`、`verified=true`、有序 `receiptDigests`、`evidenceRef`；prefix 另需 `receiptCount`。完整成功还要求正常结束及有效 canonical feedback。成功不能从 reward>0 推断，首次错误位置不能从最终失败评分推断。调用方负责提供独立可信的成功/步骤证据；没有 proof 的轨迹不导出。builder 仍验证 native token/logprob 与 v2 assembly，再复制精确 tokens 和 mask，不改变原反馈或制造训练证据。

## 实施顺序与验证入口

实现按共享 runner/阶段封存、现有 rollout/driver 接入、controller bridge/生成任务授权、保留与恢复、测试与指南拆分。复用原 checkpoint/lease 协议，并增加了冻结轮输入、预注册取消标记、原始轨迹记录与有界 opaque 数据快照归档。

```sh
PYTHONPATH=python:python/tests python -m unittest test_stages test_controller_rollout test_dataset_snapshot test_node_artifacts
GEAR_TRAINING_TEST_PYTHON=/path/to/controller/python npx vitest run tests/unit/training
npm run build
```

测试覆盖非 Codex runner 的完整 collect、真实 Python CLI 启动/响应、取消先于 worker 注册、缓存重放、基础设施新租约重试、generated episode 暂停/过期清理、独立 controller/node CAS 候选归档、可执行权限/空目录、SFT success/prefix 与 v2 assembly 篡改。另有一次实际 SDK 0.159.3 / GPT-6.1-sol high 的有界本地 manifest smoke 成功；它验证 SDK 与权限配置，不构成 GPU 更新、真实 Harbor 生成任务或质量提升认证。
