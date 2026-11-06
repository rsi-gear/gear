# Gear 项目重构：问题梳理与设计规范

状态：提案，尚未实施。日期：2026-10-11。审查基线：`05f3cf6` 的核心源码与当前工作区文档。

实施补记（2026-10-12）：本提案作为原始设计基线保留；当前进度见 [实施记录](refactor-progress.zh-CN.md)。本次实施按用户后续决定取消兼容入口，全部算法决策使用 Python，训练采用搬迁后整理。下文有关兼容周期的原提案条款不适用于本次实施，尚未通过的验收项不视为已完成。

目标：非专业用户能够快速构建 benchmark 并完成 refine；专业用户能够用 Python 快速定位、修改和验证算法。代码结构、公开接口和发布流程应共同服务这两个目标。

本文中的 `gear` 命令、`gear.*` Python API、新配置和目录结构均为**拟议接口**，不能当作当前版本的使用说明。本文只新增设计文档，不修改现有实现、实验状态或工作区中的其他改动。

## 1. 总体判断与重构决策

当前复杂度主要来自三个边界没有对齐：用户操作与内部控制协议的边界、算法决策与执行基础设施的边界、当前推荐路径与历史兼容路径的边界。

建议采用以下决策：

1. 建立完整的 benchmark 产品层：模板、导入、评分规则、检查、单题试跑、baseline、refine、报告使用同一个项目配置。
2. Python 成为算法作者的主要入口。既支持替换一个普通策略函数，也支持修改整套搜索流程；内置推荐算法本身必须使用这套入口。
3. 保留并拆分现有 TypeScript 执行层，负责会话、工作区、评测、预算、持久化、取消、恢复与最终提交。Python 负责决策，不另建一套实验状态存储。
4. 为 CLI、Python SDK、Refine Skill 提供相同的应用服务。Skill 承担自然语言交互，CLI 与 SDK 也能独立完成相同操作。
5. Python 统一使用一个 `gear` 包，benchmark、算法、refine 和 training 采用一致的公开入口。训练通过 `gear.training` 使用，在内部保持独立生命周期、worker 与可选后端依赖；`gear_training` 仅作为迁移期兼容入口。
6. 按用户闭环和算法接口分阶段迁移。先验证一条完整路径，再迁移其余策略；文件移动、行为调整和状态升级分开交付。
7. 将被优化的 Target Harness 抽象为独立 `HarnessAdapter`，把 DSH 的目录、Cordis 配置与加载规则移到 DSH adapter。重构验收必须覆盖 DSH 和 Pi，分别验证实际可修改能力。

“重构完成”必须同时满足易用性、Python 可修改性、行为正确性和代码治理的验收要求，仅完成目录整理或 Python RPC 包装不算完成。

## 2. 当前问题与证据

### 2.1 审查范围

本次阅读了 README、入门与配置指南、CLI、独立控制面、refine/search/evolution、评测与状态模块、Python 训练接口、打包和 CI 配置，并交叉检查了相关测试入口。

按 Git 跟踪文件统计，不包含 `lib/`、依赖和未跟踪实验材料：

| 范围 | 文件数 | 文本行数 |
| --- | ---: | ---: |
| `src/**/*.ts` | 143 | 37,370 |
| `python/gear_training/**/*.py` | 56 | 6,633 |
| `tests/**/*.ts` | 112 | 26,985 |
| `python/tests/**/*.py` | 48 | 5,576 |

这些数字表示维护规模，不等于缺陷数量。本次没有运行模型、GPU、Docker 或完整测试套件，不据此宣称运行功能失效。

### 2.2 阻碍目标的问题

下表 P0 表示直接阻碍本次产品目标，P1 表示结构或正确性风险，P2 表示维护成本；不是线上事故等级。

| ID | 优先级 | 观察到的问题 | 证据 | 影响 |
| --- | --- | --- | --- | --- |
| A01 | P0 | 自建 benchmark 缺少从输入到评分的产品入口。任务指南介绍 Harbor 和外部导入，没有可编辑的最小任务模板、评分器自测和预览流程。 | [任务指南](guide/zh-CN/datasets.md)，第 5–25 行；[README](../README.zh-CN.md)，第 73 行 | 用户需要先了解评测基础设施，才能定义自己的任务。 |
| A02 | P0 | 入门文档存在实质断链。datasets 引用 quickstart 中不存在的 `GEAR_SMOKE_DATASET`；Target 指南引用不存在的 bootstrap 步骤。 | [datasets](guide/zh-CN/datasets.md)，第 25 行；[target-harness](guide/zh-CN/target-harness.md)，第 7 行；[quickstart](guide/zh-CN/quickstart.md) | 按顺序阅读仍无法完成首次运行。 |
| A03 | P0 | CLI 主要提供 `serve`、`skill-identity`、原始 `request`、storage 和 training，没有 benchmark/init/evaluate/report 用户命令。 | [CLI](../src/cli.ts)，第 8–65 行 | 用户必须掌握 socket、方法名、JSON 请求和常驻服务。 |
| A04 | P0 | Python 包的公开入口属于训练；推荐搜索流程和策略 API 在 TypeScript。 | [Python 包](../python/pyproject.toml)，第 6–18 行；[Python exports](../python/gear_training/__init__.py)，第 7–11 行；[搜索 API](../src/search/api.ts) | 专业用户无法用 Python 直接修改 refine 算法。 |
| A05 | P0 | 两套算法扩展路径并存。staged GEPA 主要开放父代选择，旧 generator/assessor/selector/judge/promotion 组件在该路径被绕过。 | [算法作者指南](search-algorithm-authoring.zh-CN.md)，第 3 行及“哪些规则由框架保证”；[组件分流](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/refine/service.ts)，第 4157–4171 行 | 修改某个组件是否生效取决于执行路径，公开概念不能直接对应行为。 |
| A06 | P0 | 正式使用路径依赖源码 examples。bootstrap 等脚本及文档称为生产入口的 Codex runner 不在 npm `files` 清单内。 | [打包清单](../package.json)，第 68–98 行；[外部 runner 说明](harness-agnostic-refine-skill.md)，第 186–192 行；[示例](../examples/dsh-codex-luna/README.md) | 从发布包安装后，不能获得教程依赖的全部启动资源。 |
| A07 | P1 | 首次配置要求用户理解 substrate、manifest、runtime integrity、toolchain、compiler 等底层身份。 | [配置指南](guide/zh-CN/configuration.md)，第 5–19 行；[独立控制面](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/skill/control-plane.ts)，第 54–70 行 | 正确性机制变成手工配置负担；需要自动解析，而不是删掉校验。 |
| A08 | P1 | 核心职责集中。`RefineService` 4,188 行，Hitch evaluator 2,883 行，capabilities 2,303 行，公共 types 1,822 行，state/store 1,506 行。 | [service](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/refine/service.ts)、[evaluator](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/evaluator/hitch-cli.ts)、[capabilities](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/capabilities.ts)、[types](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/types.ts)、[store](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/state/store.ts) | 修改算法需要穿过生成、会话、证据、恢复和提交逻辑，评审影响面大。 |
| A09 | P1 | 层级依赖倒置与适配器规则外溢。state/store 导入 refine、experience、search；公共 service 对自定义 provider 也执行 Hitch 的 seed/temperature 限制。 | [store imports](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/state/store.ts)，第 1–14 行；[provider 验证](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/refine/service.ts)，第 4166–4174 行 | 存储层随业务变化；新增 provider 仍需修改核心流程。 |
| A10 | P1 | DSH 插件与独立控制面分别组装候选预算、组件、rollout 和服务；入口文件同时承担大量公开导出与装配。 | [DSH 装配](../src/index.ts)，第 54–97、206 行起；[独立装配](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/skill/control-plane.ts)，第 94–165 行 | 两个入口的默认值和能力检查存在漂移风险。 |
| A11 | P1 | 文件布局和实现身份耦合。search integrity 包含具体模块字节；组件兼容逻辑检查源码声明及 import 布局。 | [search identity](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/search/identity.ts)，第 8–15 行；[component identity](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/evolution/component-identity.ts)，第 153–173 行 | 即使行为不变，移动文件或抽函数也可能使历史恢复失配。 |
| A12 | P1 | Python 训练的直接调用与托管调用采用不同实现身份机制，公开阶段输入输出大量使用泛化 JSON。 | [TrainingLoop](../python/gear_training/loop.py)，第 33–34、64–77、152–160 行；[源码冻结](../python/gear_training/script_source.py) | IDE 难提供领域提示；改源码后直接复用 workspace 容易误判恢复边界。 |
| A13 | P2 | 规范主要依赖人工。已有 TS strict、Vitest、Python unittest，但没有仓库统一 formatter/lint 命令和 Python 公共 API 类型门禁。 | [贡献指南](../CONTRIBUTING.md)“Code structure”；[scripts](../package.json)；[pyproject](../python/pyproject.toml) | 代码风格与公共类型质量难以持续保持。 |
| A14 | P2 | 文档版本、公开 API 和 CI 门禁边界不够集中。指南标 0.1.2，包为 0.1.3；旧 `search` 广泛导出内部模块；完整 TS 回归主要面向 main/manual。 | [指南](guide/zh-CN/index.md)，第 41 行；[search exports](../src/search/index.ts)；[CI 路由](../.github/scripts/ci-changes.mjs)，第 45–47 行 | 用户难判断稳定入口；面向 dev 的结构迁移可能晚发现回归。 |
| A15 | P1 | 多套原子写实现的耐久性处理不一致：refine/training 在发布文件后同步目录，SearchStore 的对应路径未见目录同步。 | [SearchStore](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/search/store.ts)，第 126–155 行；[Refine store](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/state/store.ts)，第 378–400 行；[Training store](../src/training/store.ts)，第 14–24 行 | 需要统一明确断电与进程崩溃的恢复承诺；本次没有进行断电测试，不能据此断言已发生数据丢失。 |
| A16 | P0 | Target 构建和修改合同直接绑定 DSH。Builder 强制 Cordis preset，编辑路径在 workspace/builder/Skill 三处固定，manifest 包含 `dshBaseRef`，独立控制面直接构造具体 builder。 | [builder](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/harness/builder.ts)，第 13、333–345 行；[workspace](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/candidate/workspace.ts)，第 9 行；[Skill files](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/skill/files.ts)，第 7 行；[manifest](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/types.ts)，第 28–35 行；[装配](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/skill/control-plane.ts)，第 199–207 行 | 支持多种 Meta 宿主和可配置 Hitch harness ID，仍不能直接优化 Pi 等原生 Target。 |

预算和报告也是入口问题：现有文档已正确区分 task timeout、生成预算、覆盖率和物理执行数，但用户仍需跨多个配置项与 Gear/Hitch 命令理解一次实验。应统一呈现，不能把这些语义简单删去。

### 2.3 应保留的基础

- 不可变候选与数据身份、原始评测证据、seed/held-out 隔离、有效零分与基础设施失败的区分。
- 预算账本、评测 reservation、幂等标识、单写者锁、提交意图和 champion 比较更新。
- `ParentSelectionPolicy` 的只读输入、确定性随机与输出校验；`SearchJournal` 与内存测试实现。
- Refine Skill 的候选编辑、检查、finalize、继续与修复流程，以及独立控制面已有的宿主解耦能力。
- Python `TrainingLoop` 的普通对象接口、同步/异步支持和阶段恢复；GPU 依赖的延迟加载。
- 现有身份、恢复、打包、sandbox 和 Hitch 合同测试。测试需要按职责迁移，不能因新结构更简洁而丢弃异常场景。

## 3. 非专业用户的目标体验

### 3.1 一条完整路径

首版以 CLI 向导和 Refine Skill 为入口，不把新建 Web 管理平台作为前置条件。自然语言入口调用与 CLI 相同的服务。

首次使用先完成安装与认证准备，以下也属于发布验收路径：

```bash
npm install --global rsi-gear
gear setup
gear doctor
```

`setup` 检查兼容的 Node/Python、Hitch、隔离工具和按需的 Docker，建立受管理的 Python worker 环境，并引导创建或选择 Target/Meta profile。需要用户登录的步骤明确提示并验证；安装依赖、模型认证和 benchmark 运行分别显示状态，不能把“包已安装”当作“可以 refine”。版本矩阵决定安装组合，凭据保留在各 provider 支持的认证位置。

```bash
# 创建项目：选任务模板或导入文件，选 Target/Meta，生成必要配置
gear init my-benchmark
cd my-benchmark

# 编辑 tasks.csv，填写任务和预期结果；无需写 Python、TS 或 Dockerfile
gear benchmark check

# 单题试跑：明确使用 seed，检查环境、执行结果和评分器
gear evaluate --split seed --limit 1

# 自动补齐所需 baseline，运行一轮并展示结果摘要
gear refine --rounds 1
gear report
```

另提供 `gear doctor`、`gear resume RUN_ID`、`gear cancel RUN_ID`、`gear export RUN_ID` 和 `gear config explain`。人工管理 server/socket 保留为部署选项，不属于默认入门步骤。

`gear init` 必须生成可工作的 Target 载体、可编辑范围、实际 runtime 身份和模型配置；已有仓库采用显式导入方式，不修改用户未授权的代码。向导分别选择 Meta 与 Target adapter，重构交付至少支持 DSH 和 Pi。每个 Target 明示规则、skills、配置、代码扩展等能力及实际验证程度；不把 Meta 宿主或 Hitch 的支持列表当作 Gear Target 的支持列表。

### 3.2 Benchmark 作者合同

首版支持两种无代码模板：

| 模板 | 用户提供 | 评分依据 |
| --- | --- | --- |
| 文本或结构化输出 | instruction、expected、可选输入附件 | 明确的文本相等/规范化规则，或 JSON 字段、类型和值的断言 |
| 文件产物 | instruction、输入文件、预期产物规则 | 文件存在、内容或结构断言；预期值留在 verifier 侧 |

另支持已有 Harbor 目录导入。AutomationBench 等外部数据集通过版本化 importer 适配；适配器属于可安装产品能力，历史实验脚本仍留作历史材料。

自由文本质量不能默认用字符串相等代表。LLM rubric 和自定义 Python scorer 属于进阶模式，需显示评分规则、随机性、费用及版本；不能用隐藏的模型评判填补未定义的“成功”。

最小 CSV 示例：

```csv
id,instruction,expected,family,split
sum-01,只输出 2 加 3 的结果,5,arithmetic,seed
sum-02,只输出 4 加 5 的结果,9,arithmetic,seed
word-01,输出英文单词 apple 的大写形式,APPLE,case-conversion,held_out
```

该示例只展示格式，不足以支持有统计意义的效果结论。向导提供有正例、反例和评分自测数据的示范项目，用户可替换为真实任务。

Benchmark 的规范化模型至少包括：

| 对象 | 必需内容 |
| --- | --- |
| Task | 稳定 ID、指令、输入资源、family/tags、执行环境引用 |
| Scorer | 模板或 Python entrypoint、版本/源码摘要、预期结果的私有资源引用、正反例 fixtures |
| Metric | 稳定名称、单位、方向、范围（如有）、通过谓词、重复/任务聚合方式、缺失语义 |
| Split | 明确的 seed/held-out task IDs，及分配依据 |
| Manifest | 所有输入、任务、评分器、环境和 importer 的不可变来源身份 |

简单 CSV 中的 `expected` 是作者输入；编译后必须进入 verifier 的受控资源，不能随 task 指令挂载给 Target。Meta 只能读取允许的 seed 诊断投影。

`benchmark check` 必须零模型调用，检查重复 ID、空指令、附件、评分规则、golden fixtures、split 交集与可用指标；错误定位文件、行/任务和字段。任务未给 split 时，向导提出可审阅的确定性分组方案，按 family 避免泄漏并保存清单。数据不足以分离时，允许显式设置 `validation.mode: research`，报告必须标明“同集优化，未做独立验证”。默认 `holdout` 模式缺少独立任务时拒绝正式 refine。

检查分为静态校验、确定性 verifier 正反例自测、运行环境预检；需要构建镜像时明确显示，不把静态检查成功描述为真实任务执行成功。LLM scorer 在 `check` 中只校验规则和 fixture 结构，自测标记 `not_run`；用户显式执行 `gear benchmark probe --scorer` 后才运行计费自测并记录用量。每次正式运行固定任务内容，不静默重新划分数据。

### 3.3 配置分层

用户意图、解析后的运行计划、实验锁定记录分开维护。

```yaml
# gear.yaml：示意，由 init 生成；agent profile 引用已认证的具体配置
version: 1
benchmark: ./benchmark.yaml
target: {adapter: dsh, path: ./target, profile: default-target}
meta: {profile: default-meta}
algorithm: gepa
objective: {metric: pass_rate}
validation: {mode: holdout}
budget: {rounds: 1, max_evaluations: 40}
```

- `gear.yaml`：benchmark、Target、Meta、算法、目标和总预算；一个最小项目手写配置不超过 20 行。
- `benchmark.yaml`：CSV/JSONL 来源、模板、split 和 metric；复杂领域数据保留独立文件。
- `.gear/`：自动生成的解析计划、版本锁、状态和报告。凭据只引用认证 profile 或环境变量，不写进锁文件。
- 高级参数归属对应组件，带命名空间和明确 schema；不继续扩充一个全局大 Config。

路径相对项目根目录解析。优先级为内置模板默认值 < 项目配置 < 本次显式 CLI/SDK 参数；恢复读取已封存配置。`config explain` 显示最终值及来源，未知参数必须报错。修改冻结字段时，提示创建新实验，不能偷偷改变 `resume` 的行为。

### 3.4 预算、错误与报告

`refine` 在首次提交前显示任务范围、重复数、候选上限、现有可复用 baseline、最大评测槽位和实际适用的限制。`max_evaluations` 指整个 run 可提交的物理 trial attempt 总上限，包含 baseline、候选、最终验证和修复；逻辑评分槽位另计。适配器内部重试必须可计量，否则不得承诺硬执行次数上限。

预算均以单个 run 为单位。独立 `evaluate` 有自己的 run 和账本；复用历史 trial 不消耗新 run 的执行槽位，但保留来源和历史用量。未知是否已执行的提交继续占用预留，不能直接释放；`resume` 沿用原账本，不重新开始计量。

总运行限制、单任务 timeout、生成 token/request 限制分别命名。美元硬上限只在选定 provider 能可靠预留并结算时启用；缺失计量应拒绝该限制，不能把估算当硬保证。剩余预算不足以完成可比 baseline 或最终验证时，在相应提交前说明可做什么。

报告默认回答：初始表现、当前保留版本、可比范围内改善/退步、未完成或无效评测、修改 diff、实际消耗，以及下一步可执行动作。必须同时显示有效覆盖、有效零分、无效槽位、物理执行数；不同 local scope 的分数不能当作全量排名。

统一错误结构为 `code/message/location/retryable/next_action/run_id/operation_id`。错误区分配置问题、任务失败、评分失败、基础设施失败、预算耗尽、身份不匹配和待恢复操作；默认用用户语言解释，`--json` 保留结构化结果。

## 4. Python 算法开发体验

### 4.1 一页即可定位的修改入口

最终推荐算法必须实现在 `python/gear/algorithms/`，不能只用 Python 调用隐藏在 TS 内部的默认决策。

| 想修改的内容 | 推荐入口 | 核心运行层的责任 |
| --- | --- | --- |
| 如何挑选父代 | `algorithms/gepa/parents.py`，`ParentPolicy` | 提供合法 seed 视图，验证选择与配额 |
| 评哪些任务、多少重复 | `algorithms/gepa/sampling.py`，`TaskSampler` | 验证任务范围、证据身份与预算 |
| 诊断哪些失败、给 Meta 什么候选计划 | `algorithms/gepa/proposal.py`，`ProposalPlanner` | 提供清洗的 seed 诊断，执行生成并保存 receipt |
| 候选如何比较、哪一个进入最终验证 | `algorithms/gepa/ranking.py`，`CandidateRanker` | 验证共同评测范围和完整指标 |
| local/bridge/global 等阶段怎样安排 | `algorithms/gepa/algorithm.py`，`SearchAlgorithm` | 执行已验证的操作，持久化与恢复 |
| 何时结束搜索 | `algorithms/gepa/stopping.py`，`StopRule` | 强制总预算和取消要求 |
| 什么算成功、输出哪些原始分数 | `benchmark/scorers.py` 或项目 `scorers.py` | 固定 scorer 身份，保存原始结果及来源 |
| 优化指标、晋级底线 | `Objective` / `AcceptanceRules` 配置 | 按冻结规则执行 held-out gate 和最终 CAS 提交 |
| 模型训练四阶段与后端 | `gear.training`，`training/loop.py` 与 `training/backends/` | 维持训练恢复、设备和模型身份合同，重型依赖按需加载 |

首版提供上述接口，但只实现确有用途的内置策略。使用普通函数、dataclass 和 Protocol；不引入插件装饰器体系或要求用户继承复杂基类。

### 4.2 一个文件替换一个策略

拟议公开 API 示例：

```python
# my_policy.py
from gear.algorithms import ParentInput, ParentPlan, RandomSource


def select_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    if not view.eligible:
        return ParentPlan.abstain(reason="no eligible parent")
    selection = rng.choice(view.eligible, key="parent")
    return ParentPlan.single(selection, count=view.candidate_limit)
```

`eligible` 的元素是带 scope 的合法父代选项。这里 `RandomSource.choice` 返回 `Selection`，包含选中选项、完整抽样分布、随机索引和输入摘要；`ParentPlan.single` 使用该记录构造分配，不从抽中结果反推概率。框架仍校验 scope、数量和概率，不能只凭 helper 就信任任意结果。

```python
from gear import Project
from gear.algorithms import GEPA
from my_policy import select_parent

project = Project.open(".")
algorithm = GEPA(parent_policy=select_parent)
run = project.refine(algorithm=algorithm, rounds=1)
print(run.report.summary)
```

Python SDK 提供同步入口和对应异步入口；Notebook 中可 `await project.arefine(...)`。运行前由 SDK 管理或连接兼容 runtime，输出当前阶段；不能要求算法作者复制 socket 请求代码。

`python -m gear algorithm test my_policy:select_parent` 使用 CPU toy fixture 校验输入输出、越界行为、确定性和身份。只测试策略与默认 toy round 不需要 Node、模型凭据、Hitch、Docker 或 GPU；安装了 npm runtime 时，`gear algorithm test` 也可转发到同一测试入口。真实 `refine` 会连接执行层。

专业用户开发可以使用 editable install；生产运行自动封存本地算法源码、声明的本地依赖、包版本和配置。修改算法后生成新身份与新实验，已有实验继续使用冻结实现或明确拒绝恢复。

### 4.3 整套算法的边界

更改阶段顺序使用一个明确的增量决策接口：

```python
class SearchAlgorithm(Protocol):
    def step(self, view: SearchView, state: AlgorithmState) -> Decision: ...
```

- `SearchView` 只包含已验证的 seed 证据、候选摘要、允许的任务范围、已完成操作、预算快照和确定性随机源，不包含 store 或 held-out 原始数据。
- `AlgorithmState` 是有 schema/version 的 JSON 状态。`Decision` 返回状态更新、决策理由和下一组操作意图。
- V1 操作限定为诊断 seed（`diagnose_seed`）、生成候选、评测 seed 子集、提名一个候选进入最终 gate、停止。诊断同样具有 operation ID、证据引用和用量记录，消耗相应模型请求/token 预算。local/bridge/global 是 Python 算法内的规划逻辑，不再由核心执行器写死。
- 核心先验证并原子保存 decision、状态和 operation IDs，再执行副作用；同一步骤回放已保存决策。操作成功或失败后，以受控结果驱动下一步。
- 算法可以按冻结规则调整探索和任务分配，不能写 champion、修改已消费证据、重置预算或任意查询 held-out。
- 插件所需 LLM 诊断等非确定性操作通过声明的生成/诊断端口执行并记录；纯策略内不得偷偷发请求。用户修改一个策略无需实现这整个接口。

默认 GEPA 的阶段函数分别命名且可以直接阅读；`algorithm.py` 只表达流程。默认配方和外部自定义算法走同一公开合同、验证器和测试工具。

### 4.4 排名与最终晋级分开

Python 决定推荐哪个候选、哪些 seed 证据值得补齐。晋级阈值、质量约束、验证模式在 admission 时封存；运行层对固定提名执行最终 gate，只有证据完整且满足规则才更新 champion。

新算法可以采用不同的 seed 搜索流程；不能在看到 held-out 失败后反复改提名或阈值。未来若引入新的晋级统计方法，作为独立版本化 gate 合同交付与验证，不能把任意 Python 回调当作有权直接更新 champion 的接口。

`validation.mode` 在 admission 封存：`holdout` 使用独立 held-out gate；`research` 在冻结的 seed 比较范围上按同样预设的指标和完整性约束决定是否保留候选，不执行独立 held-out 验证。后者所有决定与报告记录 `validation_mode=shared-set-research`，不能描述为独立验证通过，也不能在原 run 中切换模式。

### 4.5 统一 Python 包与训练入口

一个 Python 发行包提供 `gear` 命名空间，统一发布 benchmark、算法、refine SDK、算法 worker 和训练模块。专业用户只需学习同一套安装、版本、配置和错误约定：

```python
from gear import Project
from gear.algorithms import GEPA
from gear.training import TrainingLoop, TrainingConfig
```

- `gear.training` 是正式公开入口；训练核心位于 `gear/training/`，Slime 等后端位于 `gear/training/backends/`。新文档和示例统一使用该入口。
- 基础安装包含 CPU 可用的训练协议与 `TrainingLoop`。`import gear`、`import gear.training` 和 CPU toy loop 不导入 GPU 框架，不要求安装 Slime、PyTorch、CUDA 或启动训练服务。
- 重型后端通过可选依赖组及版本化环境配置安装，只在选用该后端时加载。算法 testkit、benchmark 和普通 refine 不承担 GPU 依赖；后端 worker 可以在独立环境或远端运行。
- 训练与 refine 共享领域合同、artifact 引用和身份/错误规范，各自拥有明确的状态机、资源所有权和恢复流程。统一包不改变原有训练与 harness refine 的执行语义，不自动建立联合进化循环。
- `gear_training`、`gear-training` CLI 和已有 `python -m gear_training.*` 模块命令在公告的兼容周期内保留薄转发入口，不维护第二套训练实现。若旧 Python 发行名仍需提供安装兼容，只发布依赖统一发行包的过渡元包；正式版本以统一包为准。

包路径变化会影响基于模块名或源码字节的实现身份。兼容 import 只能解决调用迁移，不能证明历史任务可以使用新 runtime 恢复；旧任务必须由匹配的冻结 runtime 继续，详见第 8 节。

## 5. 目标架构与代码组织

### 5.1 责任分层

```text
CLI / Refine Skill / Python Project API
                  │
           Application services
     benchmark / evaluate / refine / report
                  │
      ┌───────────┴───────────────────┐
      │                               │
Python algorithm worker       TypeScript durable runtime
纯策略、搜索阶段与计划   ←→    预算、操作、证据、恢复、最终 gate
                                      │
                   evaluator / generator / target / storage ports
                                      │
                    Hitch、DSH、外部 Meta、filesystem 等 adapters

gear.training：统一 Python 包内的训练模块，内部使用独立生命周期与可选后端 worker
```

跨进程调用发生在算法决策步骤和批量证据投影层，不逐 token 或逐轨迹事件调用。大体积轨迹使用受控 artifact 引用与按需 seed 摘要。

### 5.2 建议目录

先在现有 `src/` 和 `python/` 内建立模块边界，Python 保持统一发行包；不把 monorepo 工具切换作为第一阶段工作。

```text
src/
  domain/              # benchmark、candidate、evidence、objective、run 合同
  application/         # 初始化、评测、refine、报告等用例
  runtime/             # 操作账本、预算、调度、恢复、最终提交
  ports/               # Evaluator、Generator、HarnessAdapter、ArtifactStore
  adapters/
    hitch/             # submit/inspect/cancel、证据解码、能力探测
    dsh/               # Target builder、native Meta 与 plugin glue
    pi/                # Pi 原生资源、extension 加载与运行描述
    skill/             # 外部 Meta、Skill gateway/transport
    python/            # 算法 worker 协议与进程管理
    storage/           # 文件实现、锁、原子写、历史读取
  cli/                 # 解析参数、调用 application、渲染结果
  training/            # 训练应用边界，后续按相同原则细分
  compat/              # 已发布旧 API/算法/状态适配，禁止新增业务逻辑
python/
  gear/
    __main__.py        # 无需 Node 的算法测试与检查入口
    project.py
    benchmark/
    algorithms/gepa/
    refine/
    training/
      loop.py          # CPU 可用的公开训练循环
      contracts.py     # 训练阶段、checkpoint 和结果合同
      backends/        # Slime 等后端，重型依赖延迟加载
    testing/
    _protocol/         # 生成的跨语言类型与传输实现
  gear_training/       # 迁移期薄转发入口，不承载第二套实现
contracts/             # 跨语言 wire schema、版本、golden vectors
templates/             # 版本化 benchmark 与 Target 模板，必须随包发布
examples/              # 仅依赖公开 API 的简短可运行用例
docs/
  guide/               # 当前发布版本的任务导向指南
  design/              # 已决策的架构/协议说明
  history/             # 明确标记版本的旧设计与实验说明
```

这是目标归属，不要求首个 PR 批量搬完目录。文档和实验链接迁移时保留重定向或索引，不能破坏历史来源。

### 5.3 当前模块的处置

| 当前模块 | 目标处置 |
| --- | --- |
| `src/refine/service.ts` | 拆为 admission、baseline、generation、evaluation repair、round coordinator、publication 用例；编排器通过端口调用，不含 provider 私有规则 |
| `src/search/engine.ts` 与决策 helpers | 逐步迁到 Python GEPA；冻结旧实现用于历史实验，新实验最终只使用 Python 推荐实现 |
| `src/search/runtime.ts`、journal/预算 | 提取执行与恢复能力；算法特有 scope/阶段决策回到 Python |
| `src/evaluator/hitch-cli.ts` | 分为 transport、capabilities、submission/recovery、evidence decoder、trajectory reader；共享已验证合同 |
| `src/capabilities.ts` | 按 benchmark、candidate、evaluation、report 等用例提供 facade，权限检查留在边界 |
| `src/index.ts` 与 `skill/control-plane.ts` | 抽出唯一 composition root；入口只声明所需 adapters 并调用装配 |
| `src/types.ts` | 按领域拆合同；保留兼容 re-export，禁止新代码依赖总类型文件 |
| `src/state/store.ts` | 存储实现仅依赖 domain/contracts/ports；业务转换在 application/compat |
| `examples/*` 中生产脚本 | 把 bootstrap、runtime runner、doctor 产品化；示例只演示公开入口 |
| `src/harness/builder.ts`、candidate/Skill 的路径规则 | 通用 Git 封存保留在核心；DSH 配置/导入/加载规则进入 DSH adapter；各入口共用同一份 adapter mutation policy |
| `python/gear_training` | 实现逐步迁至 `python/gear/training`，补公共类型与身份规范；旧目录只留迁移期转发，GPU 后端依赖按需安装与加载 |

依赖规则由 CI 校验：domain 不依赖 adapters/application；策略不依赖 runtime/store；runtime 不导入具体 Hitch/DSH；adapters 可以依赖 domain/ports；跨语言合同不依赖任一运行时框架。类型引用循环与实际运行时循环分别报告，新增运行时循环禁止合入。

### 5.4 多 Harness：Reef 对照与 Target 边界

本节基于 2026-10-11 读取的 Reef 提交 `c87878cc37efde490fd928be89ede36a7605fdbc`，为源码与测试定义的对照，未运行其真实集成测试。

Reef 将可演化内容表示为 config、rules、skill、agent_command、code_extension 等条目，再由 adapter 决定文件路径、启动命令、环境变量、模型绑定与轨迹读取方式。其通用 renderer 和宿主专属处理分开，外部 adapter 也可通过注册入口接入。[Reef adapter 合同](https://github.com/Human-Agent-Society/reef/blob/c87878cc37efde490fd928be89ede36a7605fdbc/docs/developer-guide/harness-adapters.rst)

例如，Pi adapter 把规则与扩展写入 `pi-agent/AGENTS.md` 和 `pi-agent/extensions/`，通过 `PI_CODING_AGENT_DIR` 指向独立配置根；DSH adapter 使用 `DSH_HOME`、Cordis patch、skills 目录和 `.mjs` 插件，宿主专属逻辑将插件接入实际 patch 加载链。[Pi descriptor](https://github.com/Human-Agent-Society/reef/blob/c87878cc37efde490fd928be89ede36a7605fdbc/reef/harness/adapters/pi/descriptor.yaml)，[DSH descriptor](https://github.com/Human-Agent-Society/reef/blob/c87878cc37efde490fd928be89ede36a7605fdbc/reef/harness/adapters/dsh/descriptor.yaml)，[DSH render](https://github.com/Human-Agent-Society/reef/blob/c87878cc37efde490fd928be89ede36a7605fdbc/reef/harness/adapters/dsh/quirks.py)

支持深度需要分层说明：Reef 底层 DSH adapter 可以渲染代码插件，但当前内置 Reefine proposer 仅为 Pi 生成 `code_extension`；DSH 的默认请求修改范围为规则、skills 和命令。多 adapter 支持不代表所有宿主都支持任意上游源码修改。[Reefine 修改种类](https://github.com/Human-Agent-Society/reef/blob/c87878cc37efde490fd928be89ede36a7605fdbc/reef/recipe/reefine/evolution.py#L66-L75)

Gear 的设计应明确区分三个角色：Meta adapter 负责提出修改；Target `HarnessAdapter` 负责候选资源、构建与加载；evaluation provider 负责 benchmark 执行和证据。更换其中一个不应隐式替换另外两个。

保留 Gear 的原生文件工作区与 Git 快照。每个 Target adapter 提供类型化资源说明，用户可以按宿主原生方式修改文件；核心不再强制所有候选包含 `preset/agent.cordis.yml`。最小合同如下：

| 接口责任 | 内容 |
| --- | --- |
| `describe` | adapter/runtime 版本、支持的资源类型、模型绑定和运行条件、可供 Meta 阅读的宿主修改指南 |
| `mutation_policy` | 可写/受保护路径、依赖与导入规则；编辑工具、封存与构建共用同一规则 |
| `prepare` / `check` | 生成或导入初始载体；执行宿主专属格式、构建、加载检查，返回具体覆盖项 |
| `execution_spec` | 为精确候选快照生成可供 Hitch 或其他 provider 使用的启动/安装描述与非秘密配置身份 |

通用 Git 提交、候选摘要、预算、状态、评测账本和恢复继续由核心持有；adapter 不自行实现一套搜索或存储。运行任务仍交给 evaluation provider，避免 adapter 与 Hitch 各自维护一套调度器。模型凭据使用受控引用，不能写入候选资源或身份摘要。

支持矩阵至少区分：声明支持、静态检查、实际加载、行为测试、benchmark 闭环。Pi 的 extension 与 DSH 的 plugin/hook 分别验收实际行为；只生成文件或能启动进程不能标为“代码扩展优化已支持”。修改宿主上游 runtime 源码属于另一项显式能力，本轮不因支持扩展文件而自动宣称支持。

新 manifest 使用版本化的 `adapterRef`、`runtimeIdentity`、`baseRef`、`mutationPolicyDigest` 和资源清单；DSH 的特定字段归其 adapter。旧 manifest 的 `dshBaseRef` 和 digest 按旧版本读取，不能直接改名重算历史摘要。

## 6. 必须保持的合同

### 6.1 单一状态所有者

TypeScript durable runtime 是 refine run、预算、operation journal 和 champion 的唯一写入者。Python 仅返回决策及可序列化算法状态，不能维护另一份“已完成评测”数据库。

每次副作用使用稳定 `operation_id`。进程退出或超时不等于外部任务停止；未知结果先 inspect/reconcile，再决定重试。若 adapter 无法判断是否已经提交，则进入需要恢复的状态，不能无条件重发并声称不会重复计费。

Python 算法崩溃时保留上次已提交 decision；对未提交且没有副作用的步骤可使用同一输入重试。并发 worker、旧 worker 回写和取消后的结果都受 operation owner/generation 校验。

统一底层原子文件、目录同步、不可变对象发布和锁原语，分别声明支持平台上的耐久性保证；保留各领域独立状态机。提交 decision/状态/operation IDs 可通过一个原子 journal 记录实现，不能依靠多个独立文件的写入顺序假装原子事务。

### 6.2 证据与隔离

- benchmark、scorer、Target、模型/采样、实际 provider 条件、重复槽位共同决定原始评测身份；不把 raw metrics 与用户优化权重混成一个身份。
- raw metrics、失败原因、usage 和来源原样保留。缺失或无效值不得补零、删题或改变分母；有效零分不得当作故障重跑来挑结果。
- baseline 仅在实际条件可比且证据可验证时复用。单题 smoke 只能复用相同槽位，不代表完成全部 baseline。
- seed/held-out 权限贯穿 API、文件挂载、日志、报告和 Python worker。Meta/算法运行进程不获得完整私有状态目录或 held-out artifact 权限。
- 报告中的操作者视图与 Meta 视图分开；用户查看最终 held-out 结果不应自动进入后续 Meta 提示。
- 最终提名、gate、研究 archive 与 champion 更新保留独立记录；发布/export 的权限和记录不因简化 CLI 而消失。

受托管的 Python worker 必须复用平台 sandbox：只挂载冻结算法代码及依赖、授权的 seed 投影和独立 scratch，使用隔离工作目录与最小环境，默认禁用网络。原始 `tasks.csv`、项目根目录、完整 `.gear`、凭据和 held-out 数据均不挂载；artifact 引用通过受控读取端口解析，不接受任意主机路径。仅有 stdio 进程隔离不满足这一要求；平台无法提供所需隔离时阻止受托管正式运行。纯离线 toy test 不读取真实项目数据。

### 6.3 跨语言协议与身份

使用版本化 JSON 消息，通过受控子进程 stdio 传递；stdout 仅用于协议，stderr 用于日志。消息含 `protocol_version/request_id/run_id/step_id/input_digest`；握手校验支持的协议、操作类型、能力、消息大小与实现身份。逐步超时、取消、crash、重复响应和过期响应有明确错误码。

`contracts/` 是 wire 合同的单一来源。生成 TS/Python 传输类型并提供运行时结构校验；Python 作者层使用薄 dataclass/Protocol 包装。语义校验集中在 runtime，算法侧可提前校验，但不能把安全决策交给插件自证。

新增合同明确 UTF-8、缺失字段与 null、有限浮点数、整数范围、map key 排序和随机算法；跨语言 golden vectors 必须覆盖非 ASCII key、浮点、空集合和嵌套结构。禁止 pickle 作为插件协议。

当前 evolution、training、resource digest 的排序规则并不完全相同，详见 [training digest](../src/training/digest.ts)、[resource protocol](https://github.com/rsi-gear/gear/blob/9a1281dba7495ea454c637d1bbad4e1605f52db6/src/state/resource-protocol.ts) 与 [state digest](../src/state/digest.ts)。不能直接“统一工具函数”后重算历史摘要。新 canonical 格式使用新版本；旧记录继续按旧规则验证。

实现身份分为协议版本、算法源码包、策略配置、adapter 执行条件和数据身份。拆分语义可解释性，但仍记录实际实现字节；不能为了让恢复通过而把真实源码变化排除在身份之外。历史 continuation 使用兼容 runtime；新算法版本创建新 run，并通过 lineage 关联旧实验。

### 6.4 Provider 能力合同

每个 provider 声明并验证自己支持的 seed、temperature、子集评测、幂等提交、恢复、取消和计量能力。核心只依据能力合同做 admission，不出现无条件的 Hitch 特例。

模板导入使用标准 BenchmarkSpec，并由适配器编译为实际执行格式；初期可以继续落到 Harbor/Hitch，不要求同时重写评测执行器。Hitch wire decode 在其 adapter 内完成，domain 使用 Gear 的稳定证据合同。

## 7. 整洁规范与测试要求

### 7.1 开发规范

- 为 TS 设置统一 formatter/lint，保持现有 strict 类型约束；Python 使用统一格式、lint 和公共 API 静态类型检查。先在新目录与修改文件启用，再逐步覆盖旧目录。
- 一个模块对应一个明确职责；新增超过约 500 行或函数超过约 80 行时要求评审说明，不为凑行数拆出无语义的小文件。
- 对外接口具名导出并有稳定性标识；测试 helper 从 testkit 导出，生产 API 不导出 store 内部和私有 runtime。旧 exports 在 compat 中保留。
- 默认值只有一个解析入口；配置 schema、help 和文档样例从同一来源生成或校验。
- 禁止静默 fallback、宽泛 `any` 穿透公共边界和同一业务规则多处实现。外部输入先校验再构造领域对象。
- 错误使用稳定 code，日志包含 run/operation/phase；事件不含凭据或越权数据。注释解释约束、因果和兼容理由。
- 新接口至少有一个独立安装的最小例子；教程样例随发布包提供，不依赖源码相对路径。

### 7.2 按能力组织验证

| 层级 | 验证内容 | 必需环境 |
| --- | --- | --- |
| 算法单元与 toy round | 策略、阶段计划、固定随机、配额、排序、停止条件 | Python + CPU |
| 协议合同 | 双语言序列化/摘要、无效输出、版本与能力拒绝 | Node + Python，无模型 |
| durable runtime | 中断点、重复请求、预算预留、取消、未知提交、CAS | fake adapters + 临时目录 |
| 发布包旅程 | init → 构造任务 → check → evaluate → refine → report | 实际 tgz/wheel，离线 fake provider |
| 真实集成 | 标准模板、真实环境与 verifier、Hitch/Target 适配 | 支持的平台与固定依赖；计费模型单独受控运行 |
| 训练与统一包 | 无 GPU 依赖的导入/CPU loop、旧入口兼容、既有协议测试；涉及后端时的 GPU 证据 | 基础 wheel 与后端环境分别验证 |

fake e2e 证明控制流程，不能代替真实 task/verifier 验证。真实模型结果不要求每次相同，验收关注合同、覆盖和可恢复性，不承诺每轮一定涨分。

面向 dev 的架构 PR 必须执行受影响单元、合同、依赖边界和发布包测试；切换默认算法前要求完整 TS/Python 回归及真实集成。文档 PR 校验路径、命令样例和语言版本；不要求无关 GPU 测试。

## 8. 迁移计划与退出条件

不预先承诺工期。每阶段结束必须提交可运行产物、对应证据及回退方式；后续规模由前一阶段验证结果决定。

| 阶段 | 主要交付 | 完成条件 |
| --- | --- | --- |
| M0：锁定基线 | 整理公开接口、历史状态与 digest 版本；冻结默认 GEPA 决策/恢复 fixtures；建立能力矩阵与模块依赖报告 | 已有关键合同可复现；知道哪些文件移动会影响身份 |
| M1：新手纵向闭环 | benchmark 模板/导入/check、项目配置、doctor、Target 初始化、evaluate/refine/report；正式打包 runner | 从发布包构建自有小任务集并跑通一轮；无需 clone Gear；先复用当前算法 |
| M1b：多 Target 纵切 | 抽出 `HarnessAdapter` 与统一 mutation policy；迁出 DSH 专属规则；接入 Pi 原生布局、扩展及执行描述 | DSH/Pi 均完成修改、行为检查、评测与恢复；新增 Pi 不需改搜索算法和通用状态机 |
| M2：Python 策略纵切 | 统一 `gear` Python 包、`gear.training` 公共入口、toy testkit、协议 worker、父代策略入口、源码封存；共用 composition root | 一个 Python 文件替换父代策略；TS/Python 决策一致；故障恢复合同通过；基础包的训练导入与 CPU loop 无 GPU 依赖 |
| M3：统一算法事实来源 | GEPA 采样、提案计划、排名、停止与阶段流程迁入 Python；提供整套算法 API | 固定 fixtures 上计划、预算、排名与晋级等价；默认实现实际通过公开 API 执行 |
| M4：执行层分解 | 按职责拆 service/evaluator/capabilities/store/types，归拢 provider 规则；训练实现归入 `gear/training` 并补公共类型、身份及后端边界 | 无新增运行时依赖环；通用核心不依赖具体 adapter；训练只有一套实现；旧入口和历史任务恢复验证通过 |
| M5：默认切换与收尾 | 新 CLI/SDK/Skill 默认新路径，旧路径进入 compat；文档、发布包与贡献指南统一 | 第 9 节验收全部通过，迁移与回退演练完成 |

M1 的用户层和 M2 的协议工作可以在 M0 合同确定后并行；M1b 尽早使用 Pi 验证 Target 抽象，必须在 M5 前完成，不留作重构后的可选工作。M3 必须等待 Python 纵切证明身份、恢复和成本可控。M4 按迁移经过的模块增量完成，不在最开始进行大规模搬家。

兼容规则：

1. 现有 `gear-refine`、稳定 TS exports、Python `gear_training` 和 `gear-training` CLI 至少保留一个明确公告的兼容发布周期；旧字段和入口给出弃用提示与迁移结果，不静默改变含义。
2. 已完成历史记录不改写，新 runtime 对旧格式只读。活跃旧 run 仍由匹配的兼容 runtime 正常持久化。配置迁移默认 dry-run，输出新文件和字段映射；状态转换使用独立目录并保留原件。
3. 活跃旧 run 由兼容 runtime 继续；不能直接切到 Python 新引擎恢复。新实验可在核验后引用旧 baseline 的原始证据，并保存来源与新的目标评分身份。
4. 对算法迁移先做离线 shadow/replay，比较已固定输入下的决策。差异按“预期修正”或“回归”逐项解释；禁止为了达成等价而修改历史结果。
5. 回退通过选择旧入口与兼容 runtime 完成，不让旧 runtime 读取新格式状态。新路径停止后先完成资源和外部操作核对，再启用回退。
6. compat 的移除门槛是公告周期结束、支持的历史 run 可继续或读取、迁移样例验证完成；未达到门槛不能宣布清理完成。
7. 训练模块搬迁时，为新运行封存新的模块路径、源码及后端身份。当前默认阶段身份包含类模块名，bridge digest 又覆盖源码路径与字节；保留历史 `stage_id`、digest 和 checkpoint 来源，禁止通过字符串替换旧模块名来强行匹配。活跃旧训练任务继续使用匹配的旧版本 runtime；新版本的旧 import/CLI 转发与历史恢复分别验收。
8. 同步迁移 TS/Python 子进程使用的模块命令，包括 `python -m gear_training.job`、`stages`、`node`、`artifacts` 等现有入口。冻结用户源码时同时保护 `gear` 与兼容命名空间，禁止用户源码遮蔽框架模块；更新 npm 文件清单和 wheel 包发现规则，确保 `gear.*` 与必要兼容入口实际包含在发布产物中。

## 9. 最终验收

| ID | 验收场景 | 合格标准 |
| --- | --- | --- |
| U1 | 非专业用户首次使用 | 在依赖和凭据已准备的受控环境，5 名未接触项目的用户至少 4 名在 30 分钟内完成自建任务、单题评分、一轮 refine 与报告；模型耗时和镜像下载单列 |
| U2 | 无代码创建 benchmark | 至少两套标准模板不要求写 Python/TS/Dockerfile；每题都能预览输入、评分规则及一正一反例 |
| U3 | 最小配置 | 手写意图配置 ≤20 行；不手填 SHA、manifest、socket 或 compiler 路径；可导出完整解析计划 |
| U4 | 发布包可用 | macOS/Linux 从发布产物完成安装、setup/认证检查及运行旅程，无 Gear 源码依赖；模板、worker 和 runner 实际随包提供 |
| U5 | 状态解释 | 正常通过、有效零分、评分失败、环境失败分别展示；没有把缺失值计零或把 smoke 当完整 baseline |
| U6 | 多 Target 闭环 | 同一份 benchmark 和算法分别用于 DSH、Pi；通过选择 Target adapter 完成 edit → check → evaluate → resume，不要求 Pi 伪装为 Cordis preset；两者分别建立符合身份的 baseline |
| P1 | 快速定位算法 | 新开发者只读一页索引，10 分钟内定位父代、采样、提案、排名和流程五个入口 |
| P2 | 快速修改算法 | 一个 Python 文件替换策略并通过 toy round；不改 TS、不从私有路径 import、不需要模型或 GPU |
| P3 | 整体算法可修改 | 第二个简单搜索算法只通过公开 Python API 改变阶段计划并完成一轮，证明接口没有与 GEPA 耦死 |
| P4 | 实现身份 | 改策略源码或依赖产生新身份；同一冻结输入和 seed 得到相同决策；恢复复用已提交决策 |
| P5 | 统一 Python 包 | 单个基础发行包提供 benchmark、algorithms、refine 和 training；npm 与 wheel 产物包含新模块；只安装基础依赖即可导入 `gear.training` 并运行 CPU toy loop，无 GPU 框架加载或训练服务启动 |
| P6 | 训练入口迁移 | 新示例使用 `gear.training`；兼容周期内旧 import/CLI/模块命令可用且只转发一套实现；TS/Python 子进程调用通过；旧任务在匹配 runtime 下的恢复、checkpoint 与预算记录保持有效 |
| P7 | Harness 扩展真实性 | 为 Pi extension 和 DSH plugin/hook 各构造一个可观察行为修改，检查其加载、执行和评分结果；能力不支持时在提交前明确拒绝，新增 adapter 不修改通用搜索/状态逻辑 |
| C1 | 预算与恢复 | 在提交前后、结果落盘前后、最终提交前后注入中断；无预算重置、重复 champion 更新或无依据重发 |
| C2 | 数据隔离 | 受托管 Python/Meta 不能通过 API、挂载文件、错误或日志拿到 held-out 原始数据；同集研究模式不提供独立 held-out gate，且有明确标识 |
| C3 | 迁移等价 | 固定 fixture 的任务选择、候选分配、证据覆盖、预算与晋级一致；允许变化有版本和理由 |
| C4 | 历史可用 | 旧身份摘要仍可验证，旧 run 可读且有受支持的继续方式；迁移前原件保留 |
| Q1 | 代码边界 | 层级依赖检查、公共导出检查和格式/lint/typecheck 通过；新增通用逻辑不包含 provider 特例 |
| Q2 | 文档闭环 | quickstart 全流程作为发布测试，无缺失变量、失效步骤或包外必需资源；中英文当前版本一致 |

时间指标是待实测的产品验收目标，当前没有完成用户实验；正确性指标必须用自动化合同及故障注入验证。

## 10. 范围、风险与默认取舍

本轮重构覆盖 benchmark 作者体验、refine 应用层、Python 搜索算法、统一 Python 包及训练入口、执行模块边界、发布和文档治理。训练纳入包整合、边界及规范整理，完整模型/harness 联合进化、自动生成 seed tasks、新 GPU 后端、托管 SaaS 和可视化工作流编辑器不作为完成前置条件。

| 决策 | 本提案默认值 | 理由与需要验证的风险 |
| --- | --- | --- |
| 是否全量改写 Python | 算法与作者 SDK 用 Python；成熟执行层保留 TS | 降低恢复与证据合同重写风险；用 M2 测量跨进程开销与开发体验 |
| 入门交互 | CLI 向导 + Skill，同一应用服务 | 先完成闭环；若用户测试仍要求 GUI，再基于现有服务增加界面 |
| 标准 benchmark 执行 | 优先复用 Harbor/Hitch adapter | 保留已有证据能力；Docker/运行依赖通过 setup/doctor 和版本矩阵管理 |
| 安装与分发 | 保留 npm runtime；一个统一 Python 发行包提供 `gear` 下的 SDK、算法、worker 和 training，版本联动 | `gear setup` 管理兼容 Python 环境；基础安装轻量，GPU 后端依赖按需启用。最终发行名称在发布前检查占用，Python import 统一为 `gear` |
| 训练组织 | 正式入口为 `gear.training`，旧 `gear_training` 只作迁移兼容 | 统一用户入口与版本；内部保留训练状态机、worker 和可选后端边界 |
| Target 支持 | 独立 `HarnessAdapter`，交付 DSH + Pi 的原生资源与扩展闭环 | 用第二种宿主验证边界；Meta、Target、evaluation provider 的支持矩阵分别维护 |
| 默认算法 | 保留 GEPA 行为后逐步迁到 Python | 避免架构与算法效果同时变化导致难以归因 |
| split 与晋级 | 默认独立 held-out；数据不足只能显式研究模式 | 新手便利不能造成评测数据泄漏或夸大结果 |

最先实施 M0，并选择“模板 benchmark → baseline → 一轮 refine → 报告”和“一个 Python 文件替换父代策略”作为两条验证主线。后续每项工作都必须对应本文的问题 ID 或验收 ID，避免以重构名义继续扩充无关功能。
