# 版本化 Slime 训练配方与离线 SFT

Gear 的模型训练使用固定 harness、不可变数据和独立 dev/held-out 评估。下面的配方都沿用原来的设备租约、GPU 时间核算、每 update 完整 checkpoint、HF 导出、暂停/恢复、评估与显式发布流程。v1/v2 controller 均可使用。RSI/harness 搜索不会自动启动这些模型更新。

## 配方与固定上游接口

Slime 固定为 `41014d1f29e201137fdffce737bb8bac65bc5219`，Megatron 固定为 `1dcf0dafa884ad52ffb243625717a3471643e087`。运行时使用原有 Gear export/optimizer loader 补丁。新增算法调用该 commit 的原生实现，Gear 不另写 loss/optimizer。

| `trainer.recipe` | Slime estimator/loss | 数据及归一化 |
|---|---|---|
| `agent-grpo-v1` | `grpo` / `policy_loss` | 保留现有 B×G 分组和用户封存参数 |
| `agent-gspo-v1` | `gspo` / `policy_loss` | 同步精确轨迹；原生序列级 importance ratio |
| `agent-cispo-v1` | `cispo` / `policy_loss` | 同步精确轨迹；原生 clipped importance sampling |
| `agent-reinforce-plus-plus-v1` | `reinforce_plus_plus` / `policy_loss` | 原始 scalar reward；强制 `normalize_advantages`；允许 G=1 |
| `agent-reinforce-plus-plus-baseline-v1` | `reinforce_plus_plus_baseline` / `policy_loss` | G≥2；组均值 baseline、不作 GRPO reward 标准差缩放；强制 advantage 归一化 |
| `offline-sft-v1` | `sft_loss`，关闭 advantages/returns | 封存离线 token/助手掩码；无在线生成、reward 分组或 behavior logprob 要求 |

前五种在线配方共享 Hitch/Harbor 精确捕获：助手 token 参与 loss，工具观察置零，完整 B×G batch 和零 policy lag。GRPO、GSPO、CISPO、REINFORCE++ baseline 仍要求 G≥2，并应用配置的零方差组策略。普通 REINFORCE++ 使用原始 reward，恒定组（包括 singleton）保留；不会因默认零方差组跳过策略而把 G=1 全部拒绝。

在线参数必须封存 `--lr`、`--kl-coef`、`--eps-clip`、`--num-steps-per-rollout` 及实际模型/并行配置。GSPO 的 ratio 计算由 estimator 选择；CISPO 的 `--eps-clip-high` 可显式设置。固定 Slime 的 canonical CISPO 单侧 clipping 设置为 `--eps-clip 1.0`，上界由 `--eps-clip-high` 调整；低于 1 的下界会保持有效。数值应按实际实验设定，示例不构成推荐超参数。REINFORCE++ 的 discount `--gamma` 也可显式封存。生命周期、loss、外部回调、OPD/critic 和异步 correction 不能通过 argv 改写。

已有 GRPO checkpoint 的兼容性摘要保持原样。新增配方明确绑定 recipe、B/global batch/DP 和 rollout 或离线数据合同；SFT 还绑定 datasetRef、shuffleSeed、maxEpochs、maxSequenceTokens、maskContract。更换算法、数据、shuffle 或 batch shape 后不能复用旧优化器。若要开始另一种算法，创建具有独立 optimizer lineage 的新实验，而不是隐式重置已训练 champion 的优化器。

## 通过四阶段脚本运行

所有配方共用 `TrainingLoop(task_source, rollout_executor, dataset_builder, model_updater)` 和控制器的 `training run` / 暂停 / 恢复接口。在线配方复用 `gear_training.online_rl`；SFT 复用 `gear_training.offline_sft`，由其构建阶段封存离线 batch，再交给共用 Slime updater。默认 native 脚本按 `trainer.recipe` 选择这两套组合。

开发者只需实现或组合四个阶段，入口和完整示例见 [开发指南](development.zh-CN.md#使用-hitchslime-基础组件)。`scriptSource` 会封存为 `trainer.script`；这与 agent runner 的选择无关。SFT 原始记录由 `seal-sft` 预先封存，运行时不接受会被忽略的旧 `stages` agent 覆盖配置。

## 离线数据作者入口

先完成 [v2 部署配置](controller-v2.zh-CN.md) 或 [v1 配置](README.zh-CN.md)，准备已有的 `controller.json`、`base-spec.json` 和 `parent-model.json`（`seal-hf` 的结果），并安装 Gear Python 包。controller 的 Python >=3.10；聊天文本入口还需要与运行时锁一致的 transformers/tokenizers。

`seal-sft` 接受两种显式输入，每个 example 的 `source` 都必须对应 base spec 中的 train task ID、family 和 `taskRef.digest`。不能填写 dev/held-out 的身份或任意自由文本来源。`init` 在提交 GPU 前读取全部记录验证来源、掩码和长度；跨 split 同 task/content/family 的隔离规则继续有效。

下面生成一条 role-token example，可直接执行；token IDs 必须替换为你已按该 parent tokenizer/template 编码的实际 token，不能把示例数值当作真实监督语料：

```sh
python - <<'PYCODE'
import json
spec = json.load(open('base-spec.json'))
parent = json.load(open('parent-model.json'))
task = spec['datasets']['train']['tasks'][0]
row = {
    'source': {'taskId': task['id'], 'family': task['family'], 'taskDigest': task['taskRef']['digest']},
    'segments': [
        {'role': 'user', 'tokens': [1, 2]},
        {'role': 'assistant', 'tokens': [3, 4]},
        {'role': 'tool', 'tokens': [90, 91]},
        {'role': 'assistant', 'tokens': [5]}
    ]
}
json.dump({'schemaVersion': 1, 'modelRef': parent['modelRef'], 'maxSequenceTokens': 64, 'records': [row]}, open('sft-input.json', 'w'))
PYCODE
gear-refine training seal-sft sft-input.json --config controller.json > sft-dataset.json
```

role-token 入口信任作者对 token 来源和模型编码的声明，结构校验验证 token ID 类型/范围、对齐和掩码；不能从数字本身证明一段文本来自助手。输入不接受任意 `lossMask`：只有 `assistant` segment 自动置 1，system/user/tool segment 置 0，第一 token 始终置 0，无监督 token 的记录会拒绝。记录封存后，tokenRoles 与 mask 再次交叉检查；原始 source task 和 verifier 内容不作为引用图上传模型节点。

通常更适合使用原始聊天文本。把 `segments` 换为 `messages`（可另加 `tools`）：

```json
{
  "source": { "taskId": "从 train task 取得", "family": "从 train task 取得", "taskDigest": "从 taskRef.digest 取得" },
  "messages": [
    { "role": "user", "content": "请说明这个训练任务的解决方式。" },
    { "role": "assistant", "content": "这里应填写审核过的实际训练答案。" }
  ]
}
```

文本入口从 sealed parent HF snapshot 选择性加载 tokenizer/config/template 文件，`trust_remote_code=False`、`local_files_only=True`。v2 controller 缺这些本地 bytes 时只从已配置模型节点下载 manifest 声明的 tokenizer/config 文件，不下载权重。模板必须有 native `{% generation %}` 助手 spans 且实际返回非空 `assistant_masks`；不支持该能力的模板会报 `assistant-mask-unavailable`。不会猜测 Qwen/其他模板的文本边界，也不会将全部 token 都设为监督。模板升级会改变 chatTemplateDigest，需要重封数据和实验。

`maxSequenceTokens` 对所有示例实行拒绝式长度检查；不会静默截断。节点还根据实际 sealed actor `vocab_size`、`max_position_embeddings`（存在时）检查词表与上下文，并在解析 Slime 参数后检查实际 Megatron `seq_length`。CPU 文本入口验证模板提供的助手 spans，仍要求作者审核语料质量和数据来源。

首版离线数据有明确上限：1024 条记录，全部 canonical tokenized records 合计 4 MiB。初始化、节点输入验证和封存均检查这些限制；这是适合验证/小批离线训练的有界入口，大规模或分页语料尚未实现。模型节点制品收集仍受既有 4096-object / 16-MiB metadata 引用闭包限制；多个 checkpoint、批次的 sample metadata 和重复 epoch 都会占用该总额度。离线数据上限不取消引用闭包总上限。

## 生成 SFT spec 与运行

先准备 `sft-hyperparameters.json`，封存实际模型 architecture/TP/PP/optimizer/学习率参数。SFT 至少需要 `--lr` 和 `--num-steps-per-rollout`，保留 Megatron 模型尺寸和实际 `--seq-length` 等配置。去掉在线 KL/clipping/rollout GPU 配置；Gear 固定 `kl_coef=kl_loss_coef=0`、`sft_loss`、关闭 advantage computation 和 rollout logprob，参考模型不会加载成 reference actor。下面使用一条 example、一次 candidate update、一次 epoch；扩大数据后再显式调整这些值。

```sh
gear-refine training put-json sft-hyperparameters.json --config controller.json > sft-hyperparameters-ref.json
python - <<'PYCODE'
import json
spec = json.load(open('base-spec.json'))
sealed = json.load(open('sft-dataset.json'))
hp = json.load(open('sft-hyperparameters-ref.json'))
spec['name'] = 'offline-sft-v1 experiment'
spec['trainer'].update(recipe='offline-sft-v1', hyperparametersRef=hp,
    rolloutBatchSize=1, globalBatchSize=1, dataParallelSize=1, updatesPerCandidate=1)
spec['offlineTraining'] = {
    'datasetRef': sealed['datasetRef'], 'shuffleSeed': 23, 'maxEpochs': 1,
    'maxSequenceTokens': 64, 'maskContract': 'assistant-token-mask-v1'
}
# 新配方/bridge 必须重新取得适用的实机证据，不能沿用已有 GRPO 认证。
spec['trainer']['runtimeLock'].update(validation='pending-gpu', probeEvidenceRefs=[])
json.dump(spec, open('sft-spec.json', 'w'), indent=2)
PYCODE
gear-refine training validate sft-spec.json --config controller.json
gear-refine training init sft-spec.json --config controller.json > experiment.json
python -c "import json; print(json.load(open('experiment.json'))['id'])" > experiment-id.txt
gear-refine training admit "$(cat experiment-id.txt)" --config controller.json > admitted.json
python -c "import json; print(json.load(open('admitted.json'))['id'])" > run-id.txt
gear-refine training preflight "$(cat experiment-id.txt)" "$(cat run-id.txt)" --config controller.json
```

上述最后一步预期报告 `gpu-probes-pending` 和缺失的配方证据。在完成下节的独立实机审计并将得到的 validated lock 放入最终 spec 后，新建对应实验，再重复 admit/preflight；不能修改已有冻结实验的 spec/runtime lock 来绕过认证。正式执行：

```sh
gear-refine training advance "$(cat experiment-id.txt)" "$(cat run-id.txt)" --config controller.json
gear-refine training status "$(cat experiment-id.txt)" "$(cat run-id.txt)" --config controller.json
gear-refine training pause "$(cat experiment-id.txt)" "$(cat run-id.txt)" --config controller.json
gear-refine training resume "$(cat experiment-id.txt)" "$(cat run-id.txt)" --config controller.json
```

按现有 controller 工作流反复 `advance` 直到 terminal。SFT 使用 pinned Slime 的 `debug_train_only` 进行 actor-only placement：训练 GPU 全部分配给 actor，rollout GPU=0；CPU data manager 只把 sealed offline examples 转成 Slime 的训练输入，不创建 SGLang engine、Hitch episode、policy lease、权重同步或 actor/rollout offload cycle。v2 `gpuScheduling.actorRollout` 和旧 `rollout` 字段为兼容现有部署/评估合同保留，对 SFT 训练分组和采样不生效。`rolloutBatchSize` 在 SFT 表示每 update 的 example 数，B 必须能被 global batch size 整除，global batch size 必须能被 DP size 整除，不作 B×G 校验。`fixedHarness`、verifier、dev/held-out 和 evaluation policy 继续用于独立评估。

SFT 的 `maxRolloutTokens` 仍是生成 token 预算，SFT 训练不产生或扣减它；旧预算字段要求保留合法正数。监督 token 不被伪装成 rollout tokens。训练长度由 maxSequenceTokens 限制，读取总量由 maxEpochs 和每 update 的 example 数限制，GPU 时间由 totalGpuSeconds 与设备租约/作业截止时间限制。`maxEpisodeSteps`、`maxGroupResamples` 不驱动 SFT 数据读取。

每个 epoch 的顺序为 SHA256 canonical `{seed,epoch,index}` 的排序，TS/Python 使用相同定义。批次明确保存 cursorBefore/cursorAfter 和 consumed record refs。每个已提交 update 的数据 position=`committedUpdate×B`；pending trainer state 与下一 cursor 先持久化，再导出并原子提交 checkpoint/commit。导出失败只重导出该 checkpoint；已经 SQLite 提交但丢失回包时不会重复优化。已晋级 champion 的新 candidate 从相同 cursor 继续，拒绝 candidate 后 champion 的 cursor 保持原状。maxEpochs 不会自动扩大；无法供应剩余完整 batch 时在 admission/preflight 报 `offline-dataset-exhausted`。

模型晋级仍先检查完整导出与 update ledger，再进行相同固定 dev/held-out 配对评估。没有质量增益不会晋级；没有显式 publish 不改变已发布模型。

## 验证和 GPU 边界

源码/API 支持和 GPU 实测分别判断。preflight 读取实际 Slime checkout 的参数选项、loss 函数和 actor-only placement/data-manager 接口；缺少接口时报告 `unsupported-slime-algorithm` 或 `unsupported-slime-sft-runtime`，未知 recipe 被拒绝。既有 runtime lock 的 bridgeDigest 也必须更新到本版真实桥接代码。

新配方的 `gear-versioned-recipe-v1` operator certificate 绑定 recipe、实际 runtime/model/设备部署、batch/data 合同和 harness identity。在线配方增加 `algorithmLossAndAdvantages` GPU audit；separate placement 不需要 colocated checks。SFT 独立要求 `sftMaskedLoss`、`sftOptimizerRecovery`、`exportReload`、`independentEvaluationHandoff`、`disconnectedAccounting` 的 GPU evidence，以及 offlineDataIsolation/controlResponseRecovery/remoteArtifactRetention 的适用进程证据；不会把旧的 offload-cycle 认证套在 actor-only SFT 上。认证仍通过 `python -m gear_training.certification --request REQUEST.json --audit AUDIT.json --store STORE_ROOT --output LOCK.json` 封存独立 operator audit，必须提供实际留存制品和相符 scope；该命令不能生成缺失的实测观察。

本次实现完成 CPU 合同和实际 pinned-source 检查：新增算法 argv/拒绝规则、REINFORCE++ singleton/raw reward、baseline centering、native HF 助手 mask、实际 Slime Sample 与 train-data conversion、工具 token 零梯度的 SFT loss、driver 的 train/save/export 与故障恢复、CLI/sealed provenance、v1/v2 独立评估晋级、远程上传 allowlist/制品收集、旧 GRPO 回归。CPU actor/Ray 注入只验证控制合同；source-derived loss 测试验证受控 tensor 路径。

**GSPO、CISPO、REINFORCE++、REINFORCE++ baseline 和 SFT 尚未获得本版实机 GPU 认证。** 旧 RTX 5090/Qwen2.5-1.5B GRPO 证据不证明这些新配方的数值正确性、GPU 内存适配、吞吐量或质量提升。需要在具体模型、节点、设备和超参数上完成每种配方的上述 GPU 审计；不得将 pending lock 标记为 validated 以代替实测。
