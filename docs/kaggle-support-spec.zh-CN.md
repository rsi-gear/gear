# Kaggle 比赛支持实现规范

状态：源码实现与合成合同/本地 Docker 隔离验证已落地；真实比赛数据与模型端到端验收待部署。日期：2026-11-04。关联需求：[Gear issue 112](https://github.com/rsi-gear/gear/issues/112)。运行入口、依赖与验证边界见 [Titanic 示例](../examples/kaggle-titanic/README.zh-CN.md)。

实现基线：Gear `05f3cf6d4ba4e03d7e267cbaf1d38fbbc6763782`；Hitch `f746c03fb0d60983e1acfff9f57554151cfba33f`。新增接口已在配套源码中实现，尚不表示已发布到 npm。

## 决策与交付范围

需要 Gear 与 Hitch 联合实现，但保持两个仓库的职责边界。Hitch 维护比赛任务 producer、隔离执行与通用运行产物接口；Gear 维护可进化的解题代码载体、搜索配置、选中候选的最终训练与导出流程。比赛逻辑留在任务包，两个框架的通用 evaluator 不增加按 `titanic` 或 `kaggle` 名称分流的代码。

首版交付 Titanic 的可重复本地优化闭环：导入数据 → 基线 → 候选迭代 → 完整本地验证 → 选定版本 → 全量重训 → 导出提交文件。支持 CSV 提交的表格二分类任务；CPU 环境足够。暂不扩展 GPU 调度、Kaggle Notebook/code competition、LLM 权重训练、自动排行榜搜索或跨比赛泛化评测。

首版继续使用真实 DSH Target 和现有 Gear candidate builder。训练算法由版本化 Python workflow 实现，Target 通过固定工具调用它。不新增 Python-only harness，不伪造 DSH 轨迹，也不把仓库整体重构作为前置条件。

与 issue 中的草案相比，交叉验证具体采用**每个 fold 一个独立 Harbor task**。当前普通 terminal driver 不自动隔离同一容器内各折的数据，独立 task 能直接复用已有容器与 verifier 边界。

## 已有能力与新增工作

| 能力 | 当前基础 | 首版工作与归属 |
| --- | --- | --- |
| 任务导入 | Hitch 已有 benchmark producer 与 Harbor 编译路径 | Hitch 新增 Kaggle/Titanic producer，输出 manifest v2 |
| 输入与角色隔离 | `harbor-role-context@1`、candidate/verifier 分离 build context、private-copy 已支持 | producer 正确绑定数据；补实际隔离测试，沿用现有资源合同 |
| 固定候选 | Gear 支持 exact commit、manifest、允许的 workflow 目录 | Gear 新增受限 DSH carrier 与 Python pipeline 示例 |
| 连续评分 | Gear 已支持 raw metrics、objective 与约束 | producer 声明 accuracy 等指标；Gear 示例配置目标 |
| 文件采集 | Harbor task 的 artifacts 已能收集文件并供独立 verifier 使用 | 复用采集，Hitch 补成功 run 的通用产物 list/export 公共接口 |
| 最终训练 | verifier-only regrade 仅重评已有产物，不重新训练 | Gear 示例提交新的 finalization task，复用同一封存 pipeline |
| 提交 Kaggle | 官方 CLI 提供下载与提交能力 | 示例包装显式 submit 操作，独立记账，不进入搜索评分 |

现有 `hitch verifier artifact` 面向固定的 verifier 诊断产物，不是 `submission.csv` 或模型文件的通用导出接口。内部 remote verifier source 也不能替代此接口：其使用条件和体积上限针对 verifier 恢复，不能推定所有成功 run 都可导出。

## 仓库分工

| 交付件 | 所属仓库 | 约束 |
| --- | --- | --- |
| 比赛配置、数据切分、任务 producer、固定评分器、任务镜像 | Hitch 的 `benchmark-packages/kaggle/` | 不访问 Gear 状态；编译产物可独立通过 Hitch 运行 |
| run output manifest、列举与导出命令、保留策略 | Hitch 通用运行记录与 CLI | 不含 Titanic 字段或评分规则 |
| 基线 pipeline、受限 Target carrier、candidate checker、启动配置 | Gear 的 `examples/kaggle-titanic/` | 只让 Meta 改指定 workflow；继续使用现有构建与身份合同 |
| 目标配置、跨 fold 比较、晋升与诊断策略 | Gear | 复用现有 objective/search；不把排行榜变成 verifier |
| 最终训练编排、产物归档、提交记录 | Gear 示例层 | 通过 Hitch 公共接口，不读取其私有目录布局 |
| 跨仓库 golden fixtures 与 canary | 两边各有消费测试 | 固定协议版本与实际验证过的版本矩阵 |

先以源码示例交付。若随后声称支持纯 npm 安装，必须将所需示例/入口纳入包文件清单并做安装后验证；不能假设当前包已经分发这些新增文件。

## 数据与任务合同

### 输入与不可变身份

导入器接受用户已下载的 `train.csv`、`test.csv`、`gender_submission.csv`。不把下载数据或凭据提交到 Git。下载操作与编译分开，编译可以离线进行。

新增 `competition.json`，字段至少包含：版本、competition slug、ID/target 列、预测类型、指标方向、允许标签、三个输入文件 digest、split seed、fold 数、Python 依赖或镜像 digest、平台、超时/CPU/内存限制和 adapter revision。Titanic 配置为 `PassengerId`、`Survived`、binary label、accuracy/maximize。

源数据变化、分区变化、runner/verifier 变化、依赖或评分映射变化必须改变任务身份。绝对宿主路径不参与语义身份。既有 evolution 不原地换数据或目标，应新建 evolution。

### 分区与执行单元

1. 对有标签训练数据按 `Survived` 分层划分 development 与 promotion holdout，默认保留 20% 作为后者；保存精确 ID 清单，不只保存随机种子。
2. development 内建立固定 5 折，生成 `titanic-dev-fold-0` 至 `titanic-dev-fold-4`。每个 task 只接收本折训练数据及验证特征，真实验证标签由独立 verifier 接收。
3. `titanic-promotion-holdout` 在整个 development 上训练、对 holdout 特征预测；真实标签仅在 verifier 一侧。
4. finalization 单独生成 `titanic-finalize`：使用完整训练文件和比赛 test 特征，不进入 seed/held-out 搜索任务集，也不产生虚构的测试准确率。

`seedTaskRef` 与 `heldOutRef` 指向编译任务包，不指向 CSV。Kaggle test 没有提供真实标签，不能当成本地 held-out 评分集。

任务采用 resource manifest v2 和既有 `hitch-resource-lock@1`。candidate 数据只能进入 candidate build context；标签和评分器进入 verifier context。不得把完整原始 train 文件先放入 candidate 镜像再依赖运行时删除，也不得通过共享缓存带入其他 fold 或 holdout 标签。当前 backend 使用 private-copy；不要求它尚未支持的 read-only resource binding。

development 的各折是同一比赛上的相关验证任务。Gear 的任务宏平均在此表示 mean-fold accuracy；当折大小不等时，它与汇总所有 OOF 行后的 pooled accuracy 不完全相同。后者可作为派生报告指标，但不能替换已封存的搜索目标。fold 数不代表独立比赛数。

### Meta 的访问边界

Meta 可以查看开发集诊断、候选源码和受控 seed 产物；不能读取 holdout 明细、原始全部数据、Hitch CAS 或控制面状态目录。held-out artifact 的访问检查不能只做在最终报告页面。

Gear Skill 的接口隐藏不等于宿主文件系统隔离。具有宿主 shell 全盘读取权限的 Meta 仍可能读取标签。严格隔离验收必须部署独立用户/容器或等价沙箱，只给 Meta 候选编辑与受控证据接口；不能把当前开发聊天环境作为此保证的证明。

promotion holdout 会参与多轮选择，因此报告必须称其为晋升验证集。若要研究意义上的最终独立估计，需另封存不参与晋升的数据或新的比赛；首版不宣称该能力。

## 可进化的 Python Pipeline

### 源码接口

Gear 示例载体保持固定的 `fixed/` runtime、插件、preset 和 manifest 校验，只允许候选修改 `harness/workflows/titanic/` 中的 Python 源码与模型参数 JSON。额外 checker 拒绝其他 harness 路径的变更；不放宽通用 builder 的目录规则。

建议目录：

```text
examples/kaggle-titanic/
  prepare.mjs
  start.mjs
  finalize.mjs
  submit.mjs
  target-carrier/
    fixed/                 # loader、run_pipeline 工具、检查器
    harness/preset/
    harness/workflows/titanic/
      pipeline.py
      features.py
      model.json
  fixtures/                # 合成数据，不包含比赛数据
  README.zh-CN.md
```

以下为新增 pipeline 协议，输入路径由固定任务配置解析，Agent 不得覆盖：

```text
python pipeline.py --train TRAIN_CSV --predict FEATURES_CSV \
  --output PREDICTIONS_CSV --seed INTEGER
```

一次调用从头训练并输出 `PassengerId,Survived`。预处理在 train 上 fit，对 predict 数据只能 transform/predict。可保存模型用于审计，但评分器只读取 CSV，不在有标签权限的进程中 import 候选代码或加载 pickle/joblib。

初始 pipeline 使用固定的缺失值处理、类别编码和一个 CPU 分类器；模型选择与特征工程可被 Meta 迭代。依赖安装、网络访问与库版本不属于可进化面，变更需重新封存环境。

### 固定执行工具

新增 DSH carrier 仅提供 `run_pipeline` 及必要的状态读取，不暴露通用 shell、任意写文件、任意命令或覆盖源码路径的参数。保留真实 native session、工具调用和错误轨迹，Target 的实际模型费用仍计入预算。每个 task/repetition 只允许一次训练调用；失败后的修改必须成为新候选，基础设施重试沿用现有执行账本。

固定 runner 从 Hitch 的已验证 exact-commit 制品取源码；不要信任 Agent 提供的本地文件路径。runner 管理的源码和执行 receipt 不得被候选进程写入。Python 进程使用无 LLM/Kaggle 凭据的最小环境，只能写本次 scratch/output；收集前结束进程组，防止后台进程继续修改输出。

这需要实现新的受限 carrier，不能直接复用现有示例的 `danger-full-access` 设置。Hitch 当前把制品上传到容器目录，不代表天然提供只读 mount。源码写隔离与 receipt 所有权必须通过真实权限测试；若现有容器用户模型不能实现，则在 Hitch/Harbor 通用执行边界补齐，不能以 prompt 替代。

receipt 至少记录 candidate commit、pipeline tree digest、task/split digest、固定 argv、seed、runtime identity、退出状态和输出 digest。源码前后 hash 本身不构成对任意代码执行的远程证明；首版承诺来源可追溯和受限执行，并用新容器重放验证可复现性。

无模型的 script harness 属于后续扩展。若要做，必须增加真实 adapter/capability 并适配 Gear，不能冒充 DSH 已执行了模型请求。

## 评分与候选选择

独立 verifier 以 PassengerId 对齐预测与标签；拒绝重复/未知/缺失 ID、额外列、缺失值和非二元标签，不依赖 CSV 行顺序。对于合法预测，accuracy 为正确预测数除以本 task 预测样本数。

成功的评分必须同时提供标准 `total_score` 和 raw metrics。Gear 当前先认证标准 score envelope，再提取 raw 指标；只写一个自定义 accuracy 字段不足以构成有效证据。无需声明没有真实定义的 `process_score`。

| 原始字段 | 来源与含义 | Gear metric |
| --- | --- | --- |
| `total_score` | 有效执行且预测合法时为本 task accuracy；可确认的任务失败按预先声明规则为 0 | 标准 `total_score` |
| `accuracy` | verifier 计算的本 task accuracy | 自定义 `accuracy`，number-v1，ratio，范围 0–1 |
| `valid_output` | verifier 完成全部输出格式和 ID 校验，0 或 1 | 自定义 `valid_output`，number-v1 |
| `completed` | 固定执行与输出校验均完成，0 或 1；不要求完美预测 | `pass_rate`，equals-v1，equals 1 |

raw metric 从可信 verifier result 的 `rewards` 中读取，例如 `verifier.result.rewards.accuracy`。producer 必须通过现有标准转换器测试这一路径；不把字段插入 Gear 严格限制字段的 `scores` 对象。seed 与 held-out 使用相同 metric revision、source、reducer 和 digest，分区差异由任务身份表达。

```json
{
  "objective": {
    "terms": [{ "metric": "total_score", "weight": 1 }],
    "constraints": [
      { "metric": "valid_output", "rule": "minimum", "value": 1 }
    ]
  }
}
```

优化目标采用带明确失败惩罚的标准 `total_score`，保留未经伪造的原始 `accuracy`。对于所有合法候选，排序与 accuracy 完全相同；对于格式错误的候选，目标仍可计算，且 `valid_output=0` 阻止晋升。这避免把缺失 accuracy 的失败候选永久停在 insufficient-evidence。原始 accuracy 只在真实可计算时记录，不参与首版约束或目标的完整性要求。

每个 raw metric 为 trial 粒度，repetitionReducer 为 mean，taskReducer 为 weighted-mean。范围、precision、单位和提取器须按现有 raw registry 完整声明。首次默认一次 attempt；训练 seed 与 rollout seed 分别记录，不混为一个随机源。

有效的零准确率应正常保存。格式错误时返回明确的 `invalid_prediction` 任务失败，提供 `total_score=0`、`valid_output=0`、`completed=0`，原始 accuracy 缺失。这是 verifier 正常完成的有效 observation，不设置 `StageResult.failure`，不抛基础设施异常。固定 runner 证明的候选程序错误/超时也按此规则处理；环境未启动、采集丢失、verifier 崩溃或证据损坏则保持基础设施失败/不可用，不能伪造为零。输出完整且受信的任务失败在 seed 与 held-out 均应终止并拒绝候选，不触发基础设施重跑；缺失目标证据的候选不能晋升。

Titanic 数据很小，首版保留现有 `failure-cluster-gepa-v1`，将所有开发 folds 纳入每个候选的比较范围，避免仅靠一折的局部提升淘汰或保留。配置需通过 scope resolution 测试：每个可晋升候选与对应 parent 都有同样 5 个 task、同样 repetition 的完整有效证据。held-out 仅在完整开发集筛选后运行，沿用配对晋升策略。

在完整搜索配置中使用以下 sizing/sampling 字段。现有合同要求 local ratio 大于零，因此保留 0.2 的配置值；shared core 已占满五折，去重后的 local 为空且权重为零。五折均由 shared bucket 等权计分，bridge 容量也为五折：

```json
{
  "taskSetSizing": {
    "basis": "seed-universe",
    "rounding": "ceil",
    "local": { "ratio": 0.2 },
    "shared": { "ratio": 0.8, "minTasks": 5, "maxTasks": 5 },
    "cross": { "ratio": 0 },
    "bridge": { "ratio": 1 }
  },
  "scopeSampling": {
    "bucketWeights": { "local": 0, "shared": 1, "cross": 0 },
    "epochPolicy": "stable",
    "sharedCoreTaskIds": [
      "titanic-dev-fold-0", "titanic-dev-fold-1", "titanic-dev-fold-2",
      "titanic-dev-fold-3", "titanic-dev-fold-4"
    ]
  }
}
```

测试还需覆盖只包含一折的 failure cluster，确保此时仍构造五折 scope、每折权重 0.2 和完整 bridge；不能只验证最终 global-seed coverage。

## Hitch 通用运行产物接口

### 公共命令与能力

新增以下公共接口，命名以此为首版提案；发布前必须固定 schema 并提供 capability：

```text
hitch runs artifacts list RUN_ID --json
hitch runs artifacts export RUN_ID --manifest-digest SHA256 --out NEW_DIRECTORY --json
```

协议为 `run-output-artifacts@1`，`hitch capabilities --json` 通过新增字段 `run_output_artifacts: "1"` 宣告能力。接口访问 Harbor 已采集且封存的 task outputs，不返回活动 workspace 路径，也不重复发起 Agent 或 verifier。

新增 manifest 的最小结构：

```typescript
interface RunOutputManifestV1 {
  schema_version: "1";
  kind: "run-output-artifacts";
  run_id: string;
  eval_id: string;
  task_id: string;
  attempt: number;
  harness_commit: string;
  task_digest: string;
  entries: Array<{
    name: string;
    path: string;
    media_type: string;
    bytes: number;
    sha256: string;
  }>;
  digest: string;
}
```

标识由 Hitch 从已确认的执行记录取得；entries 的 digest 由受信采集器计算，不能照抄 candidate 写出的 manifest。此命名空间只包含显式声明的候选输出，不包含 verifier 标签、credentials、完整环境或未声明目录。

### 封存与导出语义

- 复用 task artifacts 配置，在候选执行结束并清理其后代进程后采集；公开记录只有完成原子封存后才可见。
- list 返回同一 manifest digest；export 以该 digest 作为前置条件。导出再次核对长度/hash，拒绝截断、符号链接、路径穿越、重名和越界输出。
- 首版按本例配置单文件 16 MiB、总计 64 MiB 的产物预算；这是新增示例限制，不沿用 verifier 恢复快照的内部上限。超过限额应失败并标明原因，不静默截断模型或 CSV。
- 输出目录必须不存在；先写临时目录，校验成功后原子发布。重复导出若发现完整相同的导出清单可返回成功；不同内容不得覆盖。
- 产物与原 run 共同保留，进入现有 durable root/保留机制。活动导出持有租约或等价保护；workspace 清理不应删除已封存的提交文件。资源不存在、未封存或版本不符应返回不同错误。
- 首版以本地 direct backend 验收；公共 CLI/schema 不依赖该存储布局。daemon/远程节点若没有同等实现需报告 capability unavailable，而不是悄悄返回私有路径。

Gear 的通用 evaluator 包装器增加能力检查与只读 list/export 方法。缺少能力时，准备阶段阻止宣称支持完整 Kaggle 流程；已有非 Kaggle evolution 和只读历史查看保持原行为。Gear 不在主 score envelope 中塞入大型文件。

## 最终训练与 Kaggle 提交

`finalize.mjs` 是 Kaggle 示例的最终训练入口，与 `candidate.finalize` 的源码封存操作不同。它必须接收显式 candidate commit/manifest 和 competition config digest，验证它是用户选定的有效候选；执行中不能再次解析可变 champion 指针。新建 finalization task，调用同一 fixed runner 和 pipeline entrypoint，唯一计划内变化为训练范围扩大到全部已标注样本、预测范围切换为比赛 test。

finalization verifier 仅验证文件有效性，不能计算未知的测试 accuracy。它使用独立任务合同，不与搜索中的 accuracy registry 混合，也不影响已完成的 candidate 排名。

归档 `submission.csv`、pipeline 源码引用、可选模型、runner receipt、数据/runtime/配置 digest、搜索候选身份以及新 run ID。重训身份为上述不可变输入与训练 seed 的摘要；恢复时先查询既有 run/产物，避免崩溃后重复训练。需要新随机试验时必须产生新的 execution identity。

Titanic 提交校验依据比赛 test ID 集合和 sample submission：应有 418 条预测、两列 `PassengerId,Survived`、每个预期 ID 恰好一次、标签为 0/1，且无额外 index 或空值。行数亦与导入时 test 文件相互校验，不只硬编码 418。

`submit.mjs` 是用户显式调用的独立步骤，使用官方 Kaggle CLI/API 和宿主凭据。保存 candidate、submission 文件 digest、外部 submission ID、状态和返回分数；排行榜分数不覆写本地 CV/held-out 证据。提交超时而服务器状态不明时标记 unknown，先查询外部记录再处理，不自动再次 POST。首版允许人工导出文件并在网页提交，不阻塞本地优化验收。

## 实现顺序

| 批次 | 仓库与交付 | 依赖及完成条件 |
| --- | --- | --- |
| A | Hitch：producer、固定 verifier、resource v2 分区与合成 fixture | 可独立运行单 fold；证明标签隔离、ID 对齐和原始指标 |
| B | Hitch：通用 output list/export、封存保留、capability | 在成功和任务失败 run 上正确列举产物；导出/清理并发可恢复 |
| C | Gear：受限 DSH carrier、baseline pipeline、额外 checker | 可与 A/B 并行开发；真实 session 仅能执行固定训练入口 |
| D | Gear：目标配置、全 folds 比较、产物 API 包装 | A/B/C 的版本固定后联调；至少两个候选和一次后继继承验证 |
| E | Gear 示例：finalize、可选 submit、文档与版本矩阵 | 从选定 commit 独立重训，成功导出合法 CSV |

A 与 B 不需要新建 Kaggle 专用 eval 命令或重写 Harbor。C 的容器权限若无法在现有边界实现，先提交通用 Hitch runtime 修复并作为 D 的依赖。无需等待 Python 算法重构、通用 HarnessAdapter 重构或模型训练闭环。

## 验收与测试

### 无模型的合同测试

1. 用小型合成 CSV 验证 ID 唯一性、分层切分、各集合不重叠、固定 seed 可重现；输入变化使身份变化。
2. verifier 覆盖打乱行序、重复/遗漏/未知 ID、额外列、空值、非法标签、真实零分、缺输出和损坏证据；不靠 LLM 自报分数。
3. 两边共享 fixture 验证标准 total_score 与 raw accuracy 同时进入可信 observation；seed/held-out metric digest 相同；无 process channel 仍合法。
4. 固定候选在同样 folds 下比较；缺一折、混用 commit/seed、输出错误或原件损坏都不能晋升，正常零分不被重跑成别的结果。
5. 产物接口验证 digest 变化、路径穿越、大小限制、取消/中断恢复、未知提交状态和与清理并发。

### 容器与权限验收

使用带独特 canary 标签的合成任务，实际尝试从 candidate、Meta shell、镜像 build context、共享缓存与产物导出读取它；均不得成功。验证评分器不能执行候选代码或反序列化候选模型。验证 candidate 无法改写 fixed runner、封存源码和 receipt，候选的后台进程不能在封存后修改输出。

每折独立容器；同一 pipeline commit、相同训练 seed 和固定环境重放时，预测一致。若引入不可确定算法，必须显式更改实验协议与重复计划，不能用偶然最好一次替代已计划的重复槽位。

### 真实端到端验收

在用户已取得比赛数据、运行环境与模型凭据的前提下，跑 baseline 和至少两个候选、一次继承、完整 5 折比较及晋升验证。确认 finalization 使用指定 commit，在全量 train 上重训并导出 418 行 CSV。实际外部提交是单独的可选验收，不要求 CI 持有 Kaggle 凭据或访问排行榜。

交付报告记录实际 Gear/Hitch/Harbor 版本、平台与镜像身份，明确验证过 direct 还是 daemon。只有单题 smoke 通过不能标为完整 Kaggle 支持；未跑真实数据时只报告合成合同测试结果。

## 源码与合同依据

- Gear [数据与评测合同](hitch-evaluation-source-and-evidence-contract-spec.zh-CN.md)、[资源实现与限制](generic-storage-implementation.zh-CN.md)、[raw metrics](refine-objectives.zh-CN.md)。
- Gear [任务投影](../src/search/dataset-projection.ts)、[评测证据认证](../src/search/evaluation-adapter.ts)、[候选构建](../src/harness/builder.ts)、[Meta 宿主权限边界](harness-agnostic-refine-skill.md)。
- Hitch 基线 [资源角色物化](https://github.com/rsi-gear/agent-hitch/blob/f746c03fb0d60983e1acfff9f57554151cfba33f/src/resources/tasks.ts)、[任务资源约束](https://github.com/rsi-gear/agent-hitch/blob/f746c03fb0d60983e1acfff9f57554151cfba33f/src/backends/harbor/task-resources.ts)、[产物重评](https://github.com/rsi-gear/agent-hitch/blob/f746c03fb0d60983e1acfff9f57554151cfba33f/src/backends/harbor/regrade.ts)、[当前 CLI](https://github.com/rsi-gear/agent-hitch/blob/f746c03fb0d60983e1acfff9f57554151cfba33f/src/cli/output.ts)。
- [Titanic 比赛说明](https://www.kaggle.com/competitions/titanic/overview)与 [Kaggle 官方 CLI](https://github.com/Kaggle/kaggle-cli)。
