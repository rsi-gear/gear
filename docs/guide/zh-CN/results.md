# 阅读报告

Hitch 的终态失败会在操作结果中保留上游错误，私有回执 provenance 保留未经改写的 provider 原始结果。已认证评分（包括零分）继续有效；终态结果缺失的请求槽位记录为 `score: null` 和 `environment_failed`。由于证据收集失败前可能已经执行，缺失槽位的尝试用量按预留上限保守计费。旧版异常结果缺少 dataset/candidate/artifact 字段时，可使用匹配的冻结计划校验身份；已报告字段矛盾或成功结果不完整时仍拒绝接纳。这不会修改旧账本，也不会认证缺少镜像证据的试验。

Hitch 声明 `verifier_evidence: "1"` 时，Gear 在评测回执中冻结独立 verifier 观测，核对 run、eval、trial、attempt、任务 reward 和结构化过程组件。Python 负责组件权重/计数一致性、失败代码筛选与摘要。`score` 仍表示任务得分；过程指标只有通过 `metrics[].source.path`（例如 `verifier.process.score`）显式声明并被 objective/保护规则引用时才参与决策。失败代码支持调查假设，不代表已确定根因。

报告的 `verifier` 汇总区分 available、missing、invalid、unsupported、unavailable 与 not_captured。过程指标按名称分别汇总；只有当前范围全部任务/重复槽位都有有效过程观测时，`value` 才返回按任务权重计算的分数。`observed_trial_mean` 只描述已有试验，不能用来代替全范围结果。有效任务零分不会因次级材料缺失而改为执行失败。

`gear experience read RUN_ID REF --snapshot DIGEST --view verifier` 分页读取实际父本与候选的已冻结观测；Python `experience_read` / `aexperience_read` 接受同一视图。每试验最多 16 KiB，最多 32 个组件、16 条反馈和 32 个失败代码，保留完整计数及省略数；失败组件优先，长文本有明确截断标记。私有引用、原始 result 和 diagnostics 不进入该视图，完整来源仅在 operator 回执中。只读补取可补齐声明的指标/断言，但不会重写已经冻结的诊断或重新执行 Target。

历史编辑经验使用独立的 seed 快照。`gear experience query RUN_ID --query format` 返回最多 10 张匹配卡片；用 `--query-json '{"effects":["regressed","mixed"]}'` 可按结果、task_ids、paths、semantic_targets 筛选。`gear experience read RUN_ID REF --snapshot DIGEST --view task-results` 展示与实际代码父本在相同任务、重复数上的比较；`--view diff` 分页读取已校验的修改。后续页同时传入原 `--snapshot` 和返回的 `--cursor`，不能跨查询复用 cursor。有效零分保留；缺失或执行失败计入 unavailable，不归为没有改进。改进/退步是历史描述，不代替晋级判定。

Python 提供 `experience_query` / `aexperience_query` 和 `experience_read` / `aexperience_read`，参数 `snapshot` 对应响应的 `snapshot_digest`。Meta 每次诊断/生成之前封存经验输入，自动携带实际直接父本的编辑结果与相关失败经验，最多三张卡片；恢复不重选卡片。内置 Codex 将这一快照和冻结的 Python 查询程序复制到自身沙箱，只查询该快照。快照不含 held-out、gate、原始 receipt/provenance；provider artifact 定位符只保留摘要。查询与分类决策全部在 Python。

新快照使用 version 3 索引，记录描述符和明细分块分别按内容寻址、不可变保存。查询和自动卡片只读索引摘要；明细读取只打开指定记录、视图和页面。父本 verifier 试验按完整观测及 run/evaluation/task 身份共享存储，未变化对象也跨快照复用。父子共同 seed 范围、原始分数、选卡规则和明细值保持原有语义。捕获逐个候选处理，不再把全部完整记录组装为一个 JSON 响应。

| 边界 | 上限 |
| --- | --- |
| 快照索引 / 记录数 | 4 MiB / 4096 |
| 单记录描述符 | 2 MiB |
| 明细对象 / 单条读取项 | 256 KiB / 61 KiB |
| 单快照授权闭包的去重文件数 | 100,000（含索引） |
| 单卡片 / 自动上下文 | 2048 字节 / 12 KiB |
| 查询或读取响应 | 64 KiB |

version 3 证据不再受 12 MiB 总量限制。单条内容还须与该视图摘要一起放入页面，无法拆分的超大条目明确报错。大型数组分块，diff 分片不切断 UTF-8 字符。读取校验摘要、格式、所有权和已准入 seed 范围；先检查文件大小再进行有界读取，拒绝符号链接、硬链接和特殊文件。依赖先持久发布，最后才让不可变索引可见；中断后可幂等重试，不改写已提交观测。

原生 Codex 只收到该索引精确授权的对象闭包及冻结 Python 源码。staging 和导出校验全部依赖；普通查询不打开无关明细。导出的 version 3 `experience-snapshots.json` 通过 `latest_snapshot_digest` 和 `snapshot_digests` 列出最终快照及 Meta 实际绑定的历史快照；`experience/<digest>.json` 和 `experience/objects/<digest>.json` 保存索引与共享对象并集，不再重建完整明细的聚合 JSON。`trajectory` 仍只返回选中记录授权的来源；未捕获时为 `not_captured`，捕获失败时为 `unavailable`。

历史 version 2 单体文件保留 12 MiB 单文件上限、原始记录摘要、`experience:` 引用和快照绑定游标，读取时不迁移、不重写。新 version 3 快照摘要标识索引，记录引用仍标识完整的逻辑 version 2 记录；游标继续绑定原快照、记录和视图（或查询）。冻结 Python 源码变化会改变实现身份，本次格式升级不会自动恢复旧 run；旧实验仍须使用匹配 runtime，不会静默迁移账本或历史证据。

Hitch 声明 `trajectory_events_page: "1"` 时，Gear 在接纳 seed 评测回执时保存 canonical 内容摘要，并将每个来源绑定到原始执行、候选和任务重复槽位。读取步骤如下：

```sh
gear experience read RUN_ID EXPERIENCE_REF --snapshot SNAPSHOT_DIGEST --view trajectory
gear experience trajectory RUN_ID EXPERIENCE_REF SOURCE_REF --snapshot SNAPSHOT_DIGEST --query-json '{"limit":20,"types":["tool/call","tool/result"]}'
```

`query` 支持 `limit`（1–50）、`types`、`seq_start`、`seq_end`、`field` 和 `cursor`；字段读取要求起止序号相同。将返回的 `next_cursor` 放入同样筛选条件的 query 中继续读取。Python 对应 `experience_trajectory` / `aexperience_trajectory`，必须传 `snapshot`。页面绑定经验快照、来源摘要和筛选条件；原材料缺失、变更或越界请求明确失败，不重新运行评测。长字段使用 provider 的有界内容摘要；返回的序号只属于该 canonical session，`child_sessions: not-included` 不能解释为子会话没有发生。

内置 Codex 通过每次操作独立的只读 socket 获取同一批授权来源，沙箱不能读取 Hitch 根目录或调用项目控制命令。导出的 `trajectory-sources.json` 保存操作者可见的原始来源绑定和读取器身份，不打包完整日志；复用基线仍保留原 run/candidate 身份。

`gear experience read RUN_ID REF --snapshot DIGEST --view modification-use` 分页读取每个候选试验的修改资源使用情况；Python 同步/异步 `experience_read` 使用相同视图。卡片显示状态计数，`task-results` 显示逐题汇总。四种状态为：`observed`（确切内容已读取或注入）、`attempted-failure`（匹配的读取尝试失败）、`not-observed`（完整来源中未发现受支持 Skill 的使用）、`unknown`（证据不足）。没有日志、普通代码没有可判定的执行证据、内容不匹配或文件被删除均不会被判为未使用。

DSH/Hitch 在回执时固定原生 manifest 摘要。独立 Python 读取器只读取清单列出的 main/child 文件，校验字节数、摘要、会话身份与父子关系；符号链接、硬链接和特殊文件不作为证据。精确匹配和状态归纳在 `gear.algorithms.modification_use`，文件读取在 `gear.observations.hitch`。完整覆盖仅指清单列出的来源（`listed-files-complete`）；canonical 页面本身不能提供此证明。Pi 或其他尚无受支持原生来源的 provider 保持 `unknown`。

每次快照的未缓存观测共享 1024 次来源读取/1 GiB 原生日志预算；每次来源最多 16 个文件、每文件 32 MiB、合计 64 MiB，保留的匹配输入最多 8 MiB。每个候选的资源内容读取最多 8 MiB。超限明确反映为部分覆盖或不可用，不推出资源未使用。完整且已校验的观测按候选、变更、来源和实现身份缓存，原日志移除后仍可复用；部分/不可用来源在后续快照中重试，已封存快照不变。

每个资源最多展示 4 个动作示例，每个试验合计最多 16 个；计数保留全部已匹配动作，并单列省略数量。示例保留来源摘要、相对路径、会话与事件序号，调用 ID 只保留摘要，不复制原始日志或资源正文。每页的 `summary.conditioned_results` 返回按状态统计的父子分数，只使用双方有效的共同试验，缺失不补零；它是描述性统计，不能证明资源导致分数变化。只修改 Skill 元数据时，正文匹配也不能证明修改后的指令被执行。

```sh
gear report RUN_ID --json
```

先确认 `status`、`initial`、`retained`、`nominee` 和 `gate`。当前报告包含初始、保留与提名版本在 seed/held_out 的分数、观察槽位、所需槽位和完整性。只有完整共同范围的分数才可比较；局部高分不能当作全量提升。

| 字段 | 含义 |
| --- | --- |
| `coverage.valid` | 有效评分槽位 |
| `coverage.valid_zero` | 有效的零分，包含于 valid |
| `coverage.invalid` | 无有效分数的槽位 |
| `coverage.scoring_failed` | scorer 失败 |
| `coverage.environment_failed` | 环境或执行基础设施失败 |
| `coverage.physical_attempts` | 已结算的实际执行次数 |
| `coverage.reserved_attempts` | 尚未完成操作占用的预留 |
| `evaluation_repairs` | 修补次数、用量、原操作与前次操作引用、退避到期时间，以及次数/预算耗尽原因 |
| `evidence_projections` | 只读指标补齐次数、来源引用、请求补齐的指标、退避到期时间及阻止原因 |
| `changes` | 已校验的初始→保留、初始→提名资源差异，包含候选摘要与文件 patch |
| `usage` | provider 返回的用量；null 或缺失不等于零 |
| `plan` | refine admission 封存的初始范围、baseline 复用与适用限制；不是运行中的剩余额度 |
| `baseline_reuse` | 复用源、凭证摘要、槽位与历史用量；不计入当前 usage 或物理预算 |
| `research` | 独立 seed 档案的校验状态、摘要和对象计数；下一步命令为 `gear archive RUN_ID` |

`validation_mode: shared-set-research` 表示没有独立验证。`needs_recovery` 的报告保留失败原因及下一步命令；先修复原因再恢复原 run。

`gear export RUN_ID` 输出保留候选、manifest 和包含资源差异的同一报告。核对导出的资源和候选身份，不从一次演示结果推断泛化效果。

`gear archive RUN_ID --json` 读取独立研究档案；Python 使用 `project.archive(run_id)` 或 `await project.aarchive(run_id)`。`archive` 是不可变的内容寻址清单，`objects` 保存 seed 条件、所有候选、当前 seed 证据、原始 seed receipt 与算法决策记录。局部候选即使没有晋级也保留。held-out 证据、最终 gate 和 champion 结果不写入这个档案；它们仍属于操作者报告。

`projection` 由身份匹配的 Python 实现生成：按明确的任务集合、权重与重复数分别展示候选完整性、指标和逐任务领先者，不跨范围合并总榜。缺少权重的自定义 scope 保留原记录并标为无法投影；缺失观测不补零。`task_leaders` 是描述性比较；`parent_selections` 与 `rankings` 保留算法当时报告的记录，并不表示运行结束时重新计算的 GEPA 父代分布。具体生成实际使用的父本见 `generations`。

计量违约的 provider receipt 尚未通过证据接纳：档案只保存违约原因和 receipt 摘要，原始拒绝回包留在操作者 journal，不将其中未经校验的 evidence 作为 seed 研究材料。

交互投影最多展开 10,000 个范围内的候选×任务×重复槽位，且受 Python 响应大小上限约束。超限或投影失败时，`projection.status: unavailable` 明确给出原因；完整原始档案仍返回，不截断研究证据或改变排名分母。

每次 journal 提交前先发布档案对象和快照，中断产生的未引用快照不影响已提交 run。对象按类型打包存储，每个对象仍有独立摘要，避免大量小文件的同步开销。对象丢失或损坏时，report 仍可读取用量，并标明 `research.status: unavailable`；resume 拒绝新执行，export 拒绝导出。显式取消仍可停止已提交工作，只更新控制状态，不覆盖损坏档案或改写实验事实。导出包含与 archive 命令一致的 `research-archive.json`。升级改变投影实现后，原始档案仍可读取，投影明确返回 `projection-identity-mismatch`。

复用时，导出还包含 `baseline-source.json`，保存来源 run/journal 摘要、执行条件、原始 seed receipt 与选中证据。恢复和导出校验这份封存凭证；即使原历史目录后来移除，已接纳的证据仍可追溯。`historical_usage.scope: source-candidate-seed-operations` 表示来源候选全部 seed 操作的用量（含失败修补与只读补齐），不是只对复用槽位按比例分摊。有效零分仍可复用，held-out 从不作为优化 baseline。

`changes.retained` 与本次 run 的初始 Target 比较；`changes.nominee` 也展示被拒绝的提名版本，尚未提名时为 null。每个变更文件包含路径、added/removed/modified 状态、前后摘要和可执行标记。UTF-8 文本提供统一格式 `patch`；只改执行权限时为 `patch_status: unchanged`。二进制、非法 UTF-8 或超过 64 KiB 的文件保留元数据并明确省略原因。每组比较的文本展示上限为 128 KiB，每文件最多比较 2,000 行编辑；`omitted_patches` 统计省略内容的文件数，不会从清单中隐藏这些文件。导出的 Target 内容保持完整。

报告读取会校验封存资源及候选身份，不联系模型 provider。资源损坏时，`changes.status: unavailable` 说明失败，评分和用量仍可读取；export 拒绝不可验证的资源。这些操作者报告内容不会加入算法或 Meta 输入。

每个 `scores` 分区包含 `metrics` 原始聚合、`objective.contributions` 加权贡献、`objective.constraintResults` 约束结果及 `protection` 单题判定。声明独立断言后，还包含逐任务/repetition 的 `assertions` 原始明细和 `assertion_protection` 保护判定；任务满分也可能违反独立断言。失败的提名保留这些详情，便于区分总分不足和保护任务退步。missing/invalid 不会缩小固定分母。评分实现身份已封存；更换实现后应使用匹配 runtime 阅读或恢复原实验。

修补后的 coverage 按每个逻辑槽位的当前有效视图计算，原始 receipt 仍保留在 journal；物理用量包含所有执行尝试，只读投影补齐指标不增加物理用量。`completed` 表示运行结束，不保证每个槽位或指标都有效；同时检查 `coverage.invalid`、`evaluation_repairs.blocked`、`evidence_projections.blocked` 和分数完整性。修补策略已冻结，修改配置后需要新建 run，不能通过 resume 增加原 run 的执行/投影次数或预算。

`gear cancel RUN_ID` 先记录取消请求，再尝试确认停止；CLI 返回 `cancellation: confirmed` 才表示完成确认。后台控制器立即返回 `requested`，随后处理停止；持有运行锁的 worker 尚未退出时也可能返回 `requested`，此时查看 report 或重试取消。provider 确认工作已停止，或持久化阻止其开始后，run 才进入 `cancelled`。`cancellation-unconfirmed` 会保持 `needs_recovery`；resume 重试取消，不提交新工作。未结算的预留和未知用量继续显示，不清零。

准入时保存私有的取消连接快照（权限 `0600`），摘要绑定在 run 中。恢复取消使用原来的连接、请求和实现标识，不重新读取 profile，不检查 Target/benchmark/算法内容，也不准备依赖或启动算法；配置或产物漂移不会阻止这一停止路径。Hitch 使用原 subject 的终止 pause，Codex 使用原作业的持久取消标记与进程退出确认。快照缺失、摘要不符或 provider 无法确认停止时不会报告成功。该快照不包含 `passEnv` 变量值，不进入 Meta 上下文或导出；不要将它当作可共享的实验材料。
