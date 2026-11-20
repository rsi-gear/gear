# 项目重构实施记录

工作分支：`codex/project-refactor`；基线：远端 `dev` 的 `9a1281d`。
工作树：`/Users/tangyehui/.codex/worktrees/project-refactor/gear`。

## 用户决定

- 按项目重构规范完成代码重构，不保留兼容入口；任何 README 文件都不修改。
- 算法和可替换策略使用 Python；每套算法保留 parents、sampling、proposal、ranking、stopping、algorithm 六个文件，GEPA 实例化公共合同。
- 训练采用搬迁后整理，保留已有实现和功能；正式位置 `python/gear/training/`，废弃 `gear_training`。
- 原工作区有用户未提交内容，本次只修改独立工作树。
- 真实模型测试使用 Luna；U1/P1 的参与者计时没有实测，按用户“不需要模拟了”的回复不生成模拟结果。

## 已实现

- 训练包搬迁及 contracts、loop、storage、runtime、backends/slime、inference、data、adapters、pipelines、cli、recipes 分层；TS 子进程、示例、probes、测试和 Megatron 源码补丁的 import 路径已迁移。
- Python 公共算法合同、GEPA/RandomSearch 六模块、确定性随机源、CPU toy testkit、SDK 源码与声明依赖身份；冻结 worker、OS sandbox、生成的双语言 wire 合同。
- 原 staged-search 的前沿与分布、GEPA 父代抽样、scope/代表任务/cross/bridge 抽样、诊断聚类、排名、epoch 更新、历史候选裁剪、workplan 预算与假设分配、假设确认、研究发现总结、local/bridge 决策和整体 seed 阶段编排已迁 Python；原组件决策也已迁移，TS 仅提供这些函数的执行适配。原组件调用从启动时冻结的内存源码导入，身份绑定实际执行快照，运行中改文件不会替换决策。固定策略由持续 Python worker 执行，线程传输保持内部同步合同；缓存只保存有界纯结果，不共享可变对象，解释器退出、超时及运行环境切换都有清理路径。
- 新 ProjectApplication / ProjectController 为项目 CLI、Python SDK 和项目 socket 控制面 提供 init、benchmark check/preview、evaluate、refine、resume、cancel、report、export 和 config explain；跨 run 继承已晋级候选，champion CAS、候选 manifest v2、mutation policy 和不可变导出。
- 项目控制面支持后台运行、可重试 admission ID、断连后继续、服务停止后恢复；评测初始预算与 journal 原子提交，失败原因持久化。socket 的 client/server 已迁入 `src/adapters/skill`，持有内核锁保护单一 owner。
- npm 根入口与 `rsi-gear/skill`、原生 DSH `/gear` 和 `refine_request` 已收敛到同一 ProjectController；旧 search/worker/testing 公开子路径、gear-refine binary 和 TS parent-policy 示例入口已移除。原生 Cordis 加载及安装后导出检查通过。
- 随包 Skill 和中英文当前指南改为项目 API；历史 lease 说明移入 docs/design，Marketing 案例明确历史版本边界，24 页相对文件链接检查通过。
- 新 durable runtime 保存决策和 operation ID 后执行，未知结果先 inspect，取消传播到运行中的 provider，seed 与 held-out 分离，报告区分评分失败、环境失败和有效零分。
- DSH/Pi HarnessAdapter、原生资源模板和容器 materialization；真实宿主扩展加载及 prompt 行为测试。
- CSV/JSONL benchmark、text/json/files scorer、私有 expected、冻结附件、Harbor verifier 编译；真实 Docker verifier 正例与反例测试。
- Hitch provider 适配、幂等提交、inspect/watch/cancel、证据解码和请求身份；process provider 可用于外部 Meta。
- npm/wheel 安装旅程、格式与 lint、严格 Python 公共类型检查、依赖边界、CI 检查；包内运行素材由 assets 提供。
- 正式 `gear-meta-codex` 已替换旧 lease 入口，使用项目 operation 协议。诊断/生成 worker 具备实际 OS 文件与网络隔离、固定实现身份、独立 CODEX_HOME、结构化结果、持久 intent/receipt、内核锁所有权、重复提交和取消 fencing；调用方断连后可查询 receipt，worker 丢失返回 unknown、不自动重发。旧 runner/transport 只留在 tests/fixtures，已移出 npm/Skill 发布素材。

- 原有加权 objective 的指标提取、精确聚合、贡献与约束计算全部迁至 Python；新项目 GEPA/RandomSearch 的排名、GEPA 逐题父代前沿、最终 gate 和报告共用相同投影。原始指标与优化权重分离，缺失证据不补零、不缩分母；pass_rate 固定为完整通过谓词。seed/held-out 支持单题最低阈值、相对初始基线和不得新增失败的保护规则，core 独立复核自定义算法的提名。保护指标缺失标记不完整；报告展示拒绝提名的指标贡献和保护判定。
- 评分实现封存实际 Python/适配源码身份；更换实现后拒绝重新解释原 run。Hitch 从实际原始 trial manifest 提取声明的指标；不虚构过程或成本字段。公开双语言合同增加 raw_metrics/objective，Python 3.10 的可选 TypedDict 字段仍兼容。算法按声明的指标范围判断目标上限，默认通过率满分会停止，未达上限的过程质量可继续优化。

- 原 staged-search 剩余 counter 抽样、champion scope 选择、task-set 配额与历史难度迁入公共 Python helper 和 GEPA 实例。新公共采样器同时修复 100 × 0.07 的二进制取整误差；counter stream、分组优先级和原有成功阈值保持 fixture 行为。旧执行器身份改为覆盖完整受信任 Python 源码快照。

- 原 staged-search 的 outcome/process 聚合、探索保护、固定晋级比较、Meta 基线投影和只读历史分析已迁入 Python `observations.py`、`gates.py`、`history.py`。成功／失败分类按整批证据调用 Python，objective 比较 key 与评分一次返回；TS 中重复的 Rational/utility/weightedMean 算术已删除。固定任务权重、重复槽位、独立 process group、保护 assertion 和缺失证据语义保持，TS 继续负责来源与身份校验、冻结和持久化。

- 新 Project durable runtime 接入失败执行修补：只重跑明确的 environment/scoring failure，不重跑有效零分或有效执行的缺失 raw metric。原始 receipt 保留，当前逻辑槽位视图只能经来源匹配的修补链替换无效观测；次数、退避时间、operation ID 和物理预算同账本封存。恢复先 inspect，预算不足不部分提交失败槽位批次，seed/held-out 修补严格隔离。配置和报告已增加 evaluation.repair / evaluation_repairs，旧的未封存修补策略 run 明确拒绝恢复。

- 新 Project 的原始材料指标补齐已接入 durable runtime、Hitch、process provider 及候选封存适配层。`max_projections` 独立限制只读尝试，只补齐 objective/保护要求的不可用指标，不调用 Target 或模型、不增加物理预算、不改变原始得分或已有有效指标。来源摘要、退避、预约与 receipt 持久化；未知响应先 inspect，不支持、禁用或次数耗尽均明确报告。Hitch 封存执行和投影 receipt，只接受原材料的新增字段。独立模型过程观测与 assertion 明细不等同于这项只读能力。

- 操作者报告增加已校验的初始→保留、初始→提名文件 diff，覆盖被拒绝候选、增删改及执行权限。文本 patch 有大小/复杂度上限，二进制或省略内容保留摘要及原因，完整资源仍随 export 输出。CLI/SDK/socket/导出使用同一报告。资源校验失败时评分、预算与恢复状态仍可读，导出拒绝不可验证内容；报告字节不加入算法/Meta 视图。

- 追加审计发现的旧 RefineService 成对差值/均值、过程分聚合、必保任务退步计数、seed gate 和每次生成尝试的 token/request 分配已迁至 Python。旧 Hitch evaluator 的 valid trial 聚合也已迁 Python，并把实际评分源码身份加入评测身份。保留旧组件路径的配对分母、正 reward 通过谓词和从左到右浮点求和；来源、slot、候选身份及 provider 自报聚合的一致性检查仍由 TS 执行。

- 首次使用入口已接入同一 ProjectController：profile.create/import/list/select、project.init、environment.setup/doctor。原生 Hitch/Codex profile 具备角色、路径、固定版本和字段校验；交互向导仅收集模型与凭据引用，选择可写当前项目或以后 init 的默认值。Python SDK 提供 profile 管理与 doctor 的同步/异步入口。
- setup 在独立路径安装、导入并执行 Python toy round 后原子切换指针；安装失败保留旧环境。显式 `--hitch --target dsh|pi` 按版本矩阵准备 harness、Harbor、Docker 镜像与 daemon。doctor 验证本地 Python、实际隔离进程、provider 能力、固定镜像、环境变量存在性或复制到隔离目录的 Codex 文件登录状态；不输出凭据，不把本地登录当作模型授权，模型与 benchmark 状态保持未验证。自定义 process 的认证明确交由 provider 检查。

- 旧 TS `search/api`、`search/index` 和顶层 `testing` 导出装配已删除；Search 的合成夹具移到 `tests/helpers/staged-search-fixture.ts`，原断言与行为测试保留，发布包不再携带这些测试/旧作者入口。剩余旧执行实现仍需按能力继续收敛。

- CSV/JSONL 与原生 Harbor 导入已接入 CLI、Python SDK、Skill 的同一 ProjectController。Python 版本化 importer 冻结源数据/附件，按 family 与重复输入合并不可拆分组，保留显式注释并提出确定性 seed/held-out 分配；研究模式必须显式选择。预览保存私有不可变方案，应用核对配置和目标目录后原子切换，保留原任务文件。错误保留 JSONL 物理行号；重复字段、非有限数值和无效 fixture 在执行前拒绝。
- 原生 Harbor 导入保留 instruction、环境、tests、solution、执行权限及空目录。镜像标签从本地解析为固定摘要；预构建镜像转为 Dockerfile 基底，使 Target carrier 不被绕过。动态 ARG、Compose、多步和 Windows 环境明确拒绝。真实容器测试发现空输入目录遗失会破坏 COPY，现已把目录结构纳入导入/恢复身份；Hitch 冻结 dataset 同样检查空目录变化。原生 verifier 未声明正反例时自测保持 not_run。
- `benchmark probe [--task ID] [--scorer] [--image IMAGE]` 与同步/异步 SDK、Skill 已接入：只用 seed，明确构建/启动 Docker 环境，按需执行正式确定性 verifier 的冻结正反例。评分结果和 reward 必须一致，缺失/损坏结果不补零。报告独立保存到 `.gear/probes/`，记录实现/镜像身份、零模型调用和清理状态；不产生 baseline、实验预算或晋级记录。容器验证无网络、不传模型凭据；中断后显式回收容器，无法确认的资源列为 cleanup_required。这一阶段先覆盖确定性模板，进阶 scorer 的后续实施见下文。

- 存储清理 CLI 已与旧执行装配解耦：工作区锁提取为独立 adapter，保留记录直接通过原子文件协议读写，不再加载 RefineStateStore/SearchStore。Skill 资源类型也与旧总合同解耦。正式 tsc 构建只沿公开入口编译，npm 包不再携带旧 search/refine/evaluator/meta/notebook/worker 等执行模块；新增边界检查覆盖 CLI 动态 import。旧源码暂留作迁移行为验证，历史 canary 使用单独的 `fixture-lib/`，不发布该产物；后续仍需完成能力迁入与旧源码清理。

## 已观察到的验证

- 导入/probe 阶段的 Python 全回归：340 项，336 通过、4 项跳过（2026-10-12）；后续各批与最新全回归记录见下文，不将早期结果视为覆盖后续修改。
- 早期迁移决策的 TS 定向回归：72 项通过；1,000 tasks 规模项已在后续全量及本轮隔离复测中通过。
- Python 策略的源码/正式构建身份及运行中改源码的冻结测试：8 项通过；与原组件和 scope 抽样一起的最近定向回归共 17 项通过。
- harness 编译子进程清理：17 项通过，包括信号发送 EPERM 的故障注入；修复了事件回调抛错导致清理挂起。
- 完整 TS 第四轮：1280 通过、8 失败、31 跳过；失败涉及同步 Python 子进程偶发 30 秒超时。已改为持续 Python worker：42 项阶段、预算、所有权、历史继承与传输回归通过；13 项正式构建身份、worker 崩溃/重启与打包检查通过。150 个不同输入决策的本机对比从约 12.8 秒降到约 0.13 秒。完整第五轮通过：1292 通过、31 跳过，107 个测试文件；随后整体阶段编排迁移另经 27 项超时恢复、18 项冻结点崩溃恢复及 25 项主工作树阶段/历史/预算/构建身份检查通过。
- 本轮 epoch、预算、历史父代及持久化恢复回归：35 项通过；项目控制面与 socket 所有权/断连/失败恢复：8 项通过。
- 已捕获发布旅程中持久报告混入临时 execution 状态的问题并修复；新增 server 检查后的 DSH/Pi npm/wheel 安装旅程均通过，覆盖跨入口报告一致、请求幂等和服务正常退出。
- TypeScript typecheck/lint/50 模块依赖边界通过；Ruff 全包检查通过；mypy 28 文件通过。
- 最新公开 API 安装检查及 DSH/Pi npm/wheel CLI/SDK 离线旅程通过，包括二次 refine 继承、重复 export、自定义策略冻结与依赖身份；CI 路由/发布规则 14 项通过。
- 宿主 DSH 0.1.1-rc.2 与 Pi 0.84.1 的真实扩展加载测试通过，未调用模型。
- 缓存的 pinned Python Docker 镜像下 text/files verifier 正反例通过；这不等于真实模型的 Hitch 闭环。
- Hitch doctor 确认 Docker/Harbor 可用，但 daemon 未运行且未配置常见模型凭据；未执行付费模型、GPU 训练或用户体验实验。
- Codex operation runner 与项目控制面、原生入口、打包和历史协议 fixture：最新 8 文件 50 项全部通过，其中 11 项为新 runner 的真实 OS sandbox / 恢复 / 强杀 / 取消测试。扩展回归曾误用系统 Python 3.9；改用项目 Python 3.12 后通过。强杀故障注入捕获 macOS 进程组信号 EPERM 导致临时目录未清理，已增加精确子进程回收并验证目录清理。
- 最新 npm 安装检查确认新 gear-meta-codex 握手成功、旧 lease 素材和身份 helper 公开导出移除；更新 process 协议后的 DSH/Pi npm/wheel 安装旅程仍通过。
- 加权指标、Project/Hitch、Python worker 与 gate 定向 TS 回归：6 文件 42 项通过，包括真实隔离 Python GEPA、满分停止、两分区保护、缺失/零分、拒绝不可信提名和实现变化 fencing。旧加权评分的极值与基线约束 fixtures 继续通过。
- 最新 typecheck/lint/format、55 个 TS 模块依赖边界和生成合同检查通过；Python mypy 30 文件、Ruff 111 文件格式检查通过。npm 公开 API 与 DSH/Pi npm/wheel 安装旅程再次通过。完整 TS 第六轮为修复新发现的默认满分停止行为而主动中止；第七轮已通过：109 文件，1316 项通过、31 项跳过。随后抽样/配额尾部迁移另做定向回归，不把更早的全量结果当作这些新改动的验证。
- 抽样/配额尾部迁移：Python 算法与策略 19 项定向测试通过，完整 Python 317 项中 313 通过、4 跳过；TS 策略定向回归 76 项通过，1,000 任务规模项在与构建/恢复/Python 回归并行时约 93 秒超时（原阈值 90 秒），结束其他任务后单独复测约 69 秒通过，没有放宽超时。恢复/冻结/构建身份另 60 项通过。当前 mypy 31 文件、Ruff 格式 112 文件、TS 类型/lint/合同/边界检查通过。新增公共采样 helper 后的 DSH/Pi npm/wheel 安装旅程再次通过。
- 证据/晋级/历史投影迁移后的组合 TS 回归：25 文件、338 项全部通过，包含 1,000 任务 / 1,700 候选 seed cells 的规模项（约 67.8 秒，未放宽 90 秒阈值）、原始指标极值、独立 assertion、证据修补、断点恢复和新项目 gate。新增 7 项 Python 边界测试通过；完整 Python 回归 324 项中 320 通过、4 跳过；mypy 34 文件、Ruff 115 文件格式、TS 类型/lint/格式、55 模块依赖边界和生成合同检查通过。更新后的 npm/wheel DSH/Pi 安装旅程再次通过，包含无 GPU 基础导入及 CPU training loop；该旅程使用离线 provider，不代表真实模型运行。
- 新 Project 失败执行修补：5 文件、39 项回归通过，覆盖按 task/repetition 修补、保留有效零分及原始 receipt、次数/预算上限、未知提交、预约/结算中断、退避取消、伪造范围拒绝、held-out 隔离，以及真实 Python GEPA 的两分区最终 gate。类型/lint/格式、57 模块边界和合同生成检查通过。DSH/Pi npm/wheel 安装旅程均增加真实安装后的失败注入与单槽 repair，物理预算和冻结策略检查通过。该轮没有重新宣称更早全量 TS 结果覆盖这些新增改动。
- README 差异检查为空。

- 只读投影：Hitch/Codex/provider 42 项通过；新增预约/结算中断、冻结范围校验后，Project/算法组合 52 项通过。安装旅程捕获候选封存层未转发投影的遗漏，修复后 DSH/Pi npm/wheel 完整通过。文件 diff 与 Project 组合 53 项通过，随后增加被拒绝提名与完整导出报告一致性测试，controller 8 项通过；含 diff 的 DSH/Pi 安装旅程再次通过。类型/lint/格式、60 模块边界及合同生成检查通过。
- 成对投影尾部迁移：Python 全回归 329 项，325 通过、4 跳过；后续追加 Hitch 聚合后，6 项投影边界测试、mypy 34 文件和 Ruff 通过。此处不把较早全回归当作后续追加改动的验证。
- 成对投影尾部迁移的旧 RefineService/组件/组合回归：162 项通过。最新完整 TS 第八轮通过：107 个文件通过、4 个文件跳过，共 1354 项通过、31 项跳过，约 519 秒；包含本轮 Hitch 聚合、只读指标补齐、报告 diff 及原规模测试，未修改原超时或断言。
- 第八轮后最终构建的 DSH/Pi npm/wheel 安装旅程、公开 API 导出检查和安装后的 Codex runner 握手再次通过；训练基础导入/CPU loop、修补、投影、CLI/SDK/socket/导出报告一致性均通过。最新 lint/format、60 模块边界、生成合同和 diff 空白检查通过；当前指南 24 页本地链接检查通过，README 差异为空。未运行认证模型或 GPU 作业。

- 首次使用路径定向回归：Project/controller、Codex operation、onboarding 和打包素材共 5 文件、33 项通过。覆盖安装失败保留环境、版本矩阵与 daemon 再检查、profile 角色/adapter/字段冲突、缺失与符号链接认证文件、secret 不进入诊断，以及无模型调用。最新 npm/wheel DSH/Pi 安装旅程包含真实 managed setup、OS sandbox doctor、profile CLI/SDK，完整通过；公开 API 与安装后 Codex runner 握手通过。mypy 34 文件、Ruff、TS typecheck/lint/format、67 模块边界、生成合同与指南链接通过。未重跑认证模型或 GPU 作业。
- 旧装配依赖审查已开始：从当前 CLI、npm/Skill/training 导出和 Codex runner 计算实际运行时导入，209 个 TS 模块中 116 个可达；其余包含纯类型模块，不能整批按“不可达”删除。旧 RefineService、HitchCliEvaluator、search engine、Skill control-plane 等已不在新运行入口链上，但 `gear storage` 的旧资源保留路径仍连到旧 StateStore/SearchStore，且旧总类型合同还存在引用（训练仅共享存储原语，不依赖旧搜索装配）；下一步先处理这些连接和原行为覆盖，再删除生产旧装配。

- 删除旧导出装配、移动测试夹具后的回归：6 文件、83 项通过，原行为断言未变；typecheck、构建及发布包检查通过。安装包已断言不含 lib/search/api.js、lib/search/index.js、lib/search/testing.js 和 lib/testing.js，当前公开 Project API 与 Codex runner 握手继续通过。README 差异与 diff 空白检查均为空。

- 导入/probe：真实 Docker 下 text/files 模板评分正反例、导入原生 Harbor 后再次构建和评分均通过；正式 CLI probe 亦通过，原生环境成功时没有将缺失 fixtures 记为自测成功。应用层和 controller/Hitch/onboarding 组合 5 文件 26 项通过；随后取消 Docker 客户端、显式回收容器、清理失败上报及导入/probe 3 文件 9 项通过。完整 Python 340 项中 336 通过、4 跳过，mypy 34 文件通过。Docker 使用本地固定的 amd64 Python 镜像，在 arm64 宿主仿真运行；这不是认证模型或 GPU 作业的证据。
- 本轮安装后的 DSH/Pi npm/wheel 旅程完整通过，包含实际 managed setup、轻量 training 导入和 CPU loop、导入/应用、修补/投影，以及安装后的 Python SDK → CLI → 真实 Docker scorer probe（正例 1、反例有效零分 0、无模型调用、资源清理完成）。最新类型/lint/格式、70 个模块依赖边界、生成合同、Ruff 120 文件格式与 README/diff 空白检查通过。没有把它记为真实模型或 Linux 安装验收。

- 存储维护已脱离旧 RefineStateStore/SearchStore：共享 workspace 锁进入 adapter，资源保留记录直接使用文件存储原语。正式构建沿公开入口编译；发布包不包含旧 search/refine/evaluator/meta/notebook/worker 装配。历史行为回归通过独立 fixture-lib 构建，Vitest 在全局 setup 自动准备，避免从发布 lib 借用旧模块。存储锁与恢复 32 项、资源合同 6 项、历史构建身份/Skill 15 项及并发 dataset canary 通过；公开运行时依赖图现有 108 个模块，无旧执行装配可达。
- 第九轮完整 TS 回归：109 个文件、1347 项通过，31 项跳过；两个旧 runner/transport 文件因夹具仍引用已移出发布 lib 的模块而加载失败，已改为 fixture-lib，专项复测通过。没有把这次完整回归记为全通过。
- 训练尾部算法统一：模型 task-macro 配对均值/标准误、dev/held-out 决策、离线 SFT seed/epoch 排序统一到 Python；TS 保留证据来源/slot/合同验证。共享算法与数据 helper 源码进入 bridge/阶段恢复身份，源码变化拒绝旧结果重放。SFT 顺序与原 TS 摘要排序一致；统计按明确的 task-macro 单位计算，输出改为稳定码点顺序。独立 regression 覆盖单 task 多尝试、阈值相等、全部拒绝原因、跨 epoch 续跑及身份变化。
- 同步算法桥与异步 Python author 工具共用解释器解析器，读取 managed current.json，不再查找已废弃的固定 bin/python 路径。空覆盖变量不阻止托管选择，损坏指针和不可执行的显式路径给出一致错误。6 文件 57 项 TS 回归及解释器 3 项专项通过；Python 全回归 346 项中 342 通过、4 跳过，mypy 35 文件、Ruff 121 文件、类型/lint/格式和边界检查通过。

- 修正解释器选择后的独立 npm/wheel 安装旅程通过：实际 setup 后清空 GEAR_PYTHON 和 GEAR_TRAINING_TEST_PYTHON，DSH/Pi evaluate/refine/resume、Python SDK、socket、导入以及真实 Docker scorer probe 均通过；只有离线 provider，无认证模型调用。公开 API 包导出和已安装 Codex runner 握手再次通过。

- 第十轮完整 TS 回归通过：112 个文件通过、4 个文件跳过，共 1373 项通过、31 项跳过，约 773 秒（两个 worker）。覆盖训练统计/SFT 排序迁移、统一解释器选择及修正后的旧行为夹具；后续 CLI 入口拆分另做受影响回归，不把该全量结果当成后续改动的验证。

- 训练入口继续整理：node/job/script_job/inference/certify/slime/gpu_inventory 的参数解析或模块执行入口全部移入 `training/cli/`，服务、RPC 和进程管理实现保留在对应目录。公开控制器解析命名为 `cli/controller.py`；同步修改 TS 桥、后台进程重启、GPU 所有权探针和文档。边界检查禁止实现层引入 argparse 或模块执行分支。删除旧 `cli/launch.py` 和 `dev_grpo.py` 兼容启动器，公开运行统一使用 `python -m gear.training`，训练帮助与当前指南统一使用 `gear` binary。
- 入口拆分后 TS 训练 22 文件、165 项通过，Python 348 项中 344 通过、4 跳过；移除兼容入口后控制器 Python 5 项、TS 16 项定向通过。独立基础 wheel 验证 8 个 CLI 模块无 GPU/gateway 框架导入，6 个模块帮助入口及安装后的 gear-python training 命令通过。新 CLI 入口后的 npm/wheel DSH/Pi 完整安装旅程和 Docker scorer probe 通过。
- 修复 setuptools 增量打包遗留已删除模块的问题：纯 Python 构建清理自身生成目录；自定义目录不进行无范围约束的删除。安装旅程在临时打包源植入旧 gear_training 和已删除 CLI 残留，最终 wheel 均不包含它们。该旅程完整通过；当前源码在原 build 缓存上重建 wheel，确认移除模块缺席、controller 和共享 training 算法存在。公开 API 与安装后 Codex runner 握手通过；7 篇当前训练文档本地链接检查通过，README 差异为空。

- 控制器模块命名清理后的完整 Python 回归发现 Terminal-Bench 示例仍导入旧 cli.__main__，已同步到 cli.controller；该示例 6 项通过，最后完整 Python 回归 347 项中 343 通过、4 跳过。旧别名的 1 项测试随明确删除的兼容入口移除。当前 README 与 diff 空白检查通过。

- 新 Project 独立 assertion 已接入：声明 assertion 来源/revision 自动封存 schema digest，保留 passed/failed/excluded 与 missing/invalid/unsupported 的区别；Python 按每次 repetition 执行 must_pass/no_new_violation，不用任务总分推断断言。新旧 gate 共用同一纯判定函数，固定 32 组迁移向量覆盖 excluded 和缺失语义。报告包含全部已声明断言明细及逐槽位保护结果，未设置保护的断言也可见。
- 独立 assertion 只读补齐复用持久化 projection、原始 receipt、预算与恢复协议。只请求缺失的保护通道，不重跑有效零分，不改变已有 passed/failed/excluded；schema 漂移、越界补齐和改写已观测结果会被拒绝。held-out 证据留在独立分区，保护规则从算法视图中过滤。Hitch 从实际原始 trial 的声明字段提取，字段缺失会如实报告，不承诺 provider 已产生尚未实现的模型过程观测。
- assertion 验证：5 项 Python 测试含 32 组固定旧行为组合通过；完整 Python 352 项中 348 通过、4 跳过；5 文件 67 项 TS 组合通过，后续补充不可改写/unsupported 后 repair 文件 40 项通过。独立 npm/wheel DSH/Pi 旅程加入“task score=1、独立 assertion=failed”的原材料补齐与报告案例，完整通过，并继续通过真实 Docker scorer probe。首次该安装案例错误地用单题 smoke 期待完整 seed 分数，被既有完整性合同拒绝；改为完整 seed 评测后通过，未放宽完整性校验。mypy 36 文件、Ruff 128 文件、类型/lint/格式、合同生成、75 个模块边界与 31 篇当前指南/训练文档链接检查通过。

- 剩余 91 个未发布 TS 旧装配模块和历史 schema 已从 `src/` 移入 `tests/fixtures/retired-src/`。正式源码剩余 122 个模块，均由公开入口构建；历史行为测试继续引用夹具及共享生产原语。fixture-lib 使用完整目录结构和独立资源副本，发布包不含测试或旧装配。边界检查禁止生产代码反向引用夹具；历史 schema 重建后与原件逐字节一致。当前算法作者索引、历史工具及文档链接已同步，README 未改。
- 搬迁验证：构建身份与策略等第一组 26 项通过，发现两个 runner 旧导入和一处资源路径身份校验遗漏，修复后第二组 6 文件 67 项通过、1 项跳过。类型、生产构建、75 模块层级边界、110 模块公开运行时依赖图、安装后的公开 API/Codex runner 握手及 dataset 并发 canary 通过。CI 8 项筛选测试发现并修复 Codex 沙箱套件未触发 macOS 的遗漏。26 篇当前文档本地链接通过。第十一轮完整 TS 回归通过：112 文件通过、4 文件跳过，共 1384 项通过、31 项跳过，644 秒（两个 worker）。覆盖本次全部夹具搬迁与前一阶段独立 assertion；后续锁修复另行验证，不把该结果提前归于后续改动。

- 修复内核锁辅助进程死亡导致的所有权丢失：Node 打开并保留同一文件描述符，辅助进程仅负责对继承的描述符加锁。辅助进程被杀不会在受保护回调执行中释放锁；回调完成/失败后关闭描述符；Node 被杀后辅助进程通过 stdin EOF 退出。新增真实进程故障测试先在旧实现上复现失败，修复后 6 文件 75 项通过，覆盖 Project 恢复/取消、证据修补、Codex 操作和训练锁。Linux 固定镜像内也验证继承描述符的锁语义；该探针不是完整 Linux 安装验收。类型/lint/格式与 14 项 CI/发布规则通过，内核锁测试已纳入 macOS 平台任务。

- 取消语义收紧为“已经停止或已被持久化阻止启动”。process provider 必须明确确认；Codex 已启动 worker 必须有 receipt 且释放执行锁，worker 丢失而没有结果则保持未确认。runtime 在取消失败/不支持时保存 `cancellation-unconfirmed` 和原预约，resume 只重试取消，不增加新提交。相关 runtime/controller 16 项通过，最后 Codex/process 16 项通过。新增集成断言发现测试入口可能加载旧 lib，Vitest setup 已补正式构建，避免仅测试过期产物；原生 runner 错误继续使用脱敏 code。
- Hitch 改用有序 eval-control v2：每个 repetition 的 start 意图和稳定 eval ID 先于提交持久化，pause 序列高于 start；取消可以先于本地准备，并且不调用 submit 找回未知回包。inspect 不执行任务，部分重复已完成时返回明确的 resumable，core 仅在 provider 支持幂等提交时重入；已存在作业不会重复提交。取消后还检查终态和 active leases，不把取消请求回包当成停止证明。新 helper 源码纳入 provider 身份。
- 有序控制与修补组合 4 文件 63 项通过，覆盖丢失提交/暂停回包、迟到启动、部分重复、非幂等拒绝和活动租约。真实 Hitch daemon 临时探针第一次启动超时，第二次通过：稳定未提交 ID、pause 阻止旧 start、零 eval 作业和零模型调用，结束后确认 daemon 清理。该探针已整理为 `scripts/check-hitch-control.mjs`，不能替代模型或完整 Target 容器验收。
- 最新 npm/wheel 独立安装旅程通过：DSH/Pi、managed Python setup、CPU training、repair/assertion、SDK/CLI 和真实 Docker scorer probe 均通过；公开 API 包检查及安装后 Codex runner 握手通过。未执行认证模型或 GPU 作业。当前类型/lint/格式、76 模块边界、111 模块公开运行时图及 14 项 CI/发布规则通过；README 差异为空。

- 自定义 Python scorer 已接入：单文件同步函数返回 bool，保持 pass_rate 的二值语义；源码、入口、版本、随机种子、零模型请求声明、声明产物和正反例进入冻结身份。check/preview 只做语法与结构检查，fixtures 标记 not_run，正式 verifier 和显式 Docker probe 执行相同冻结源码。非法返回、异常与超时保持 scoring_failed；执行前移除旧 reward，防止失败后残留成功结果。评分源码与 expected 不进入 Target 环境。
- 自定义 scorer 验证：Python 22 项定向测试、TS 3 文件 10 项通过；类型、76 模块边界和公开运行时依赖图通过，Ruff 129 文件通过。更新后的独立 npm/wheel DSH/Pi 安装旅程通过，安装后的自定义 Python scorer 正反例在真实 Docker 中通过，声明文件可读取、宿主测试凭据未进入 verifier，清理确认完成。当前中英文任务指南包含完整作者合同和示例，README 未改。这仍不是认证模型闭环或 LLM rubric 验收。

- 自定义 scorer 接入后的完整 Python 回归 359 项中 355 通过、4 跳过。随后生成模板统一改用独立 verifier，/app 产物转移、私有 tests 构建上下文和评分侧 no-network 配置；相关 Python 9 项及 Project probe/repair 45 项通过。真实 Harbor 0.21 + Hitch 环境插件完成合成候选 → 产物收集 → 独立 verifier 的正反例试跑：不同 hostname、候选临时文件隔离、无外部路由、reward 1/0、容器和自建镜像清理均通过。该探针整理为 scripts/check-harbor-verifier.py，未调用模型，不宣称完成 DSH/Pi headless 模型闭环。

- LLM rubric 已接入 compiler、独立 Harbor verifier、CLI/SDK probe 与作者预览。显式声明 HTTPS endpoint、模型、rubric/版本、采样参数、单价版本、请求/token/时长限制和专用密钥变量；check 只校验并显示声明，不读凭据、不调用模型。源码和配置进入冻结身份；源码冻结与 fixtures 复制不共享作者可变对象。
- LLM 每个 fixture/trial 只发一次请求，不自动重试可能计费的失败；拒答、截断、结构无效和模型身份变化不是零分。请求前 fsync 用量标记；丢失响应或取消保留未知调用/token/费用，实际 token 与声明单价估算分开，账单金额不伪造为已知。probe 从容器失败路径也读取已持久化用量；Hitch verifier stdout 保留原始用量标记。专用评分密钥不得进入 Target passEnv，普通 scorer 继续禁网。
- LLM/自定义评分器定向 Python 16 项、TS 3 文件 20 项通过；更新后完整 Python 368 项中 364 通过、4 跳过。真实 Docker + 本地 HTTPS 假服务的 4 个场景通过：通过、不通过、拒答、503 丢失响应；每个场景只有一次请求，未知用量保留，容器/镜像清理确认。该可复用探针为 npm run test:benchmark:llm，不访问外部模型。mypy 36 文件、Ruff 130 文件、类型/lint/格式和模块边界通过。中英文指南明确估算与账单区别、凭据作用域、模型随机性和实际验证范围。

- 第十二轮完整 TS 回归通过：114 个文件通过、4 个文件跳过，共 1404 项通过、31 项跳过，约 534 秒。覆盖内核锁、取消确认、Hitch 有序控制、自定义 Python 与 LLM scorer；后续算法目录整理单独验证。

- 算法目录进一步整理：只由历史 TS 夹具调用的 `archived_*` 和旧组件投影迁至 `python/tests/retired_policies/`。正式 GEPA 六模块保留当前策略；正式内部 dispatcher 收敛到 10 个实际使用的投影/训练入口。历史 TS 夹具使用独立冻结客户端，与正式客户端共用纯传输基础设施；旧行为断言保留，夹具不进入 npm/wheel。作者索引按当前可修改入口重写，历史布局移入专门说明。整理后 6 文件 74 项正式桥/身份/Project 测试及 25 文件 586 项历史搜索/旧组件/训练用量回归通过；原有行为断言和超时未放宽。Python 全回归 368 项中 364 通过、4 跳过；mypy 33 文件、Ruff 140 文件、类型/lint/格式与边界检查通过。独立 npm/wheel DSH/Pi 安装旅程、CPU training、真实 Docker scorer、公开 API 与已安装 Codex runner 握手通过；wheel 的旧 build 缓存中预置废弃算法模块，最终安装确认不存在。README 差异为空。

- 预算审查第一批修复：报告汇总的每个用量字段必须由所有可能已执行的操作提供；缺失、null、未返回或非法/溢出的计数保持未知，估算与实际美元费用不混用。未提交预约不算已消费；core 复用当前 run 完整证据而不调用 provider 时明确记录零新增用量。决策步数按已持久化历史累计，resume 不重置，已封存 terminal 决策可在上限处完成。用量报告及 Project 4 文件 61 项通过；随后持久步数/证据复用专项 2 文件 16 项通过。最新类型/lint/格式、78 模块边界和 113 模块公开运行时图通过。这一批只覆盖用量报告和决策上限；生成/诊断预约的后续实施及验证见下条。

- 生成/诊断预算已进入 Project 配置、封存 RunSpec、provider 握手、operation 预约与恢复账本。总请求/token 上限与单次上限分别配置；整批预约先验证再提交，已知实际用量释放未消费额度，缺失/null/未知响应持续占用完整预约。计数非法、超额或 token 分项矛盾保留原始 receipt 并阻止继续提交，仍可取消。Python 两套配方根据 core 提供的批次容量安排候选；额度耗尽仍允许提名已评测候选。provider 能力来自 Meta，Target 不支持生成限额不妨碍 Meta 使用；原生 Codex 未具备操作内所有嵌套调用的硬限额，因此在执行前拒绝此配置。新增针对预约丢失确认、未知提交、超额批次、未知用量、非法统计和能力拒绝的组合测试 7 文件 104 项通过，扩展统计一致性后 2 文件 26 项通过。完整 Python 371 项中 367 通过、4 跳过；mypy 33 文件、Ruff、TS 类型/lint/格式、80 模块边界、115 模块公开运行时图与生成合同检查通过。完整 TS 与独立安装包旅程的后续结果见下条。

- 预算/用量审查第二批补齐：即使总 token 缺失，已知输入、输出或缓存分项也不能超过预约或与总数矛盾；发生计量违约后，预约不再被报告为可信消耗上界，批次容量归零。Codex native 事件按轮汇总，缺失分项保持未知；中断、未完成轮次、错误事件与溢出不把已完成部分当完整总量，缓存输入不重复累计，模型请求数不由轮次数猜测；最后一条无换行事件也会读取。计量实现纳入 runner 源码身份。重建后 4 文件 55 项预算、process、原生隔离集成与计数测试通过，类型/lint/格式通过，Python 127 文件格式检查通过。新增生成预算的独立 npm/wheel DSH/Pi 安装旅程、CPU training、真实 Docker 评分正反例、公开 API 和已安装 Codex runner 握手通过。第十三轮全量时中途修补导致 4 项 Codex 测试读取旧编译产物（其余 1438 项通过、31 跳过）；这 4 项已在重建后的专项中通过，随后第十四轮固定代码后重新完整运行，结果见下条。

- 第十四轮固定代码后的完整 TS 回归通过：117 个文件通过、4 个文件跳过；1452 项通过、31 项跳过，约 554 秒。包括整理后的历史夹具、当前 Project、生成预算、Codex 多轮用量、训练和平台隔离。随后仅修正计量违约报告的下一步提示：已持久化的违约应取消并核查 provider，再创建新 run；不继续建议无法解除该限制的 resume。该提示改动后 2 文件 30 项预算/报告专项通过；最终 TS 类型、lint、格式、81 模块依赖边界、116 模块公开运行时图和生成合同校验通过，git diff --check 通过，README 差异仍为空。

- 提交前计划与跨 run baseline 复用已接入同一 Project 服务：`gear refine --dry-run`、`run.plan`、Python 同步/异步 `plan_refine` 只检查并预览；正式 admission 重新检查并封存，普通 CLI 在执行前展示，后台调用返回 plan，报告保留初始计划。展示 seed 范围、held-out 数量、重复数、候选/物理/生成限制，以及 baseline 和最终 gate 的预算缺口；不执行算法或模型。timeout 目前标明来自 provider/任务配置，不虚构 run deadline 或美元硬上限。
- baseline 仅复用已完成、身份一致且所需原始通道可用的 seed 槽位。Target 执行身份从复合 Meta 身份拆出，改变 Meta 或 objective 权重不会改变 Target 原始观测身份；process timeout 也进入执行身份。按有效覆盖量与新旧选择来源，不按分数；有效零分保留，smoke 只覆盖自身槽位，held-out 不进入优化证据。冻结原始 receipt、执行条件与来源摘要，恢复/导出不依赖原历史目录继续存在；损坏凭证阻止新提交。历史全部 seed 操作用量单列，新 run 只计新增执行。
- 计划/复用第一批 8 文件 123 项通过；补齐 process timeout 身份后 2 文件 27 项通过。完整 Python 371 项中 367 通过、4 跳过，mypy 33 文件、Ruff 108 文件通过。加入 CLI 普通输出、CLI dry-run、Python 同步/异步预览、smoke 复用、champion 完整复用、原始材料投影复用及凭证导出的独立 npm/wheel DSH/Pi 安装旅程通过；真实 Docker scorer 和 CPU training 继续通过。公开 API 与安装后 Codex runner 握手通过。当前 85 模块层级边界、120 模块公开运行时依赖图、生成合同、格式/lint 与 28 篇当前指南/协议链接通过。第十五轮完整 TS 回归通过：118 文件通过、4 文件跳过；1473 项通过、31 项跳过，约 553 秒。README 差异仍为空。
- 第十五轮之后补齐计划中的实际超时声明：Target/Meta provider 调用、Hitch 评测/等待与 Codex operation 分开封存；Harbor agent/verifier/两侧 build 期限由同一 Python helper 生成配置与计划。原生任务保留显式值，省略字段为 null；held-out 只显示分组数量，不暴露 ID。任意 process provider 不因模板声明而被推断具备 Harbor 限制，调用超时也不等于远端终止。运行时 helper 的源码纳入 benchmark/provider/importer 身份。初次验证 Python 30 项、TS 6 文件 58 项通过；后续全 Python 与安装旅程见后续结果，未把上一轮全量覆盖算到本次补充。
- 超时补充后的完整 Python 373 项中 369 通过、4 跳过；mypy 33 文件、Ruff/格式 120 文件通过。独立 npm/wheel DSH/Pi 安装旅程再次通过，包括计划的 provider/task 超时、SDK、CPU training、真实 Docker scorer 与原生 Harbor 导入。类型/lint/格式、85 模块层级边界、120 模块公开运行时图、生成合同和 diff 空白检查通过。当前正式源码已固定，未执行额外模型或 GPU 作业。


- 原生 Harbor 导入扩展到单步 Linux Compose：保存 sidecar、依赖、健康检查、artifact service 和独立 verifier；main 的 context/Dockerfile 明确冻结，DSH/Pi carrier 写入实际 main context。主容器、sidecar、独立 verifier 的 FROM 与镜像服务均检查固定摘要；宿主挂载、外部 Compose 资源、隐式环境继承/插值及动态镜像引用拒绝导入。family 增加通用 metadata.domain 回退，无 benchmark 名称分支。
- 导入计划改为 v2 内容表，native benchmark 也共享内容：64 MiB 独立字节、4 GiB 展开字节及文件/目录数量上限分别校验；每个摘要在应用时只解码一次。Python 通道按字节累计上限并正确拼接 UTF-8，不再逐块反复测量整段字符串。Hitch dataset 封存改用独立的流式文件摘要，包含原生依赖与点文件，不再复用 Target 的 64 MiB/4096 文件限制或忽略规则。
- 版本化 benchmark.adapter.json 在导入前核验源任务集合、可执行位、文件及 dataset 摘要；保留 scoring/raw_metrics、source-manifest.json 与原始 source-benchmark.adapter.json。镜像规范化、子集编译、Target 写入之后重建执行 manifest。Node codec 仅实现 Harbor v1 的 JavaScript JSON/localeCompare 协议，不含算法决策，随 npm/Python wheel 发布；Python 各算法六模块布局未改变。当前 Hitch 公共 loader 已接受导入前/后/子集三种清单，包含 Unicode 路径和 raw_metrics。
- 本轮定向 TS 4 文件 27 项通过；新增 native 环境测试 3 项及导入等 Python 定向 21 项通过。完整 Python 379 项中 375 通过、4 跳过；mypy 33 文件、Ruff/格式 133 文件通过。独立 npm/wheel DSH/Pi 旅程通过，包含 installed Node codec/PyYAML、CPU training、实际 Docker scorer、原生 Compose 两服务启动与健康检查、没有 fixtures 时仍明确 not_run，以及资源清理。类型/lint/格式、86 个 TS 模块边界、121 个公开运行时模块与生成合同通过。最后调整 probe 镜像 tag 保留服务名大小写及允许拉取缺失的固定镜像后，3 项 probe 专项和真实 Compose build/start/cleanup 再次通过；未将第十五轮全量 TS 结果覆盖到本次修改。
- 新 scripts/check-native-harbor.py 通过真实 Harbor 0.21 与当前 Hitch 环境插件执行导入后的合成任务：main 调用 simulator、暂停 main 后收集私有 snapshot、独立禁网 verifier 评分，两个场景主分数 1/0、过程分数 1/0.5，容器与本次镜像清理完成。Hitch 标准 score/process artifact 校验也接受两份结果。首次探针暴露 fixture 少写 reward 的标准合同问题，已修正 fixture 并完整重跑；未修改 producer 或 Hitch 源码。该证据没有调用认证模型，也没有运行 AutomationBench 官方全量数据或 GPU。

- 独立研究档案已接入新 Project：每次 journal 提交前持久化 seed 条件、所有候选、原始 seed receipt、当前证据和 Python 决策记录；held-out/gate/champion 的更新不改变其摘要。内容寻址对象按类型分包，保留逐对象摘要和不可变历史快照；未提交快照不影响已提交 run。拒绝的计量 receipt 尚未通过证据接纳，只在档案中记录原因与原文摘要，完整回包仍留在操作者 journal。
- 两套算法共用可选 ResearchRecord 合同，自动记录 scope/权重/采样、排名与父代选择；TS 仅校验、封存和读取。Python research 投影按同一任务/权重/重复范围显示完整性、原始指标和逐题领先者，保留局部专长；历史抽样记录不冒充运行结束时的新分布。交互投影限制为 10,000 个范围内候选×任务×重复槽位，超限或源码身份变化时仍可读完整原始档案，投影明确 unavailable。
- 新增 `gear archive RUN_ID`、`run.archive`、Python `archive/aarchive`，export 包含相同 research-archive.json。档案损坏时报告仍保留计量；继续执行和 export 被拒绝，显式取消仍能停止已提交工作。取消专用写入只允许修改控制状态，不能改写实验事实或覆盖损坏档案。
- 研究档案第一批 8 文件 111 项通过，覆盖万条已持久决策、不重抽样、范围隔离、有效零分/无效/缺失、损坏及取消；最初逐对象 fsync 的规模超时改为分包后通过，未放宽超时。独立 npm/wheel 安装旅程通过 DSH/Pi、同步/异步 SDK、archive/CLI/export 一致性、CPU training 和 OS 隔离算法；本轮该旅程没有开启可选真实 Docker probe，之前的 Docker 证据仍单列。完整 Python 383 项中 379 通过、4 跳过；随后新增投影上限测试的 5 项研究专项、mypy 34 文件和 Ruff/格式 132 文件通过。
- 计量违约档案边界追加后发现缺失 generationBudget 的故障测试被 JSON 序列化先行阻止，现以 null 记录缺失，仍由 runtime 返回 frozen-generation-budget-missing，不恢复为无限预算。相关 4 文件 58 项全部通过，含两项在默认高并发全量中超时的历史 epoch/recovery 测试，保留原断言和超时。第十六轮默认并发全量已主动中断，不计为通过。第十七轮按 CI 的 4 worker 并发完成：118 文件通过、1 文件失败、4 文件跳过；1491 项通过、1 项失败、31 项跳过。唯一失败为原有 1,000 任务 / 1,700 候选 seed cells 规模项超过原 90 秒上限（约 92.5 秒）；无其他构建/测试任务时单独复测约 67.4 秒通过，没有修改该项代码、断言或超时。不把此次全量称为全部通过。
- 本轮最终完整 Python 回归 384 项中 380 通过、4 跳过。再次从独立 npm/wheel 安装验证 DSH/Pi、CPU training、真实 OS 隔离算法、CLI/同步异步 SDK/socket 的 archive 一致性与不可变导出，全部通过；未开启可选 Docker probe 或调用外部模型。最终类型/lint/格式、89 模块层级边界、124 模块公开运行时图、生成合同及 diff 空白检查通过；27 篇当前指南/协议的相对链接通过。README 修改和新增检查均为空。

## 历史经验迁移

本轮新增 seed 历史经验：Python `algorithms/experience.py` 负责实际父本的逐任务结果分类、相关性排序、自动卡片选择和有界分页；`gear/experience.py` 仅负责独立快照的 JSON I/O。未做 seed 评测的代码修改没有结果经验；缺失/失败观测不补零，卡片保留修改假设、理由和完整性。provider artifact 定位符转为摘要，原始 reason/receipt/provenance 不进入 Meta 经验。

Project application 从接纳的生成操作、当前 seed 证据和校验过的 Target diff 构建不可变快照。runtime 在 journal 提交前绑定经验摘要与 operation ID；恢复不重选输入，快照损坏阻止新提交。Meta 自动携带实际直接父本与相关失败/语义目标的最多三张卡片；内置 Codex 把单个净化快照及冻结 Python 读取程序复制进独立 OS 沙箱。真实隔离测试发现虚拟环境解释器链接被拒绝，已改为运行实际解释器路径；原私有文件隔离仍通过。

新增 `gear experience query/read`、`experience.query/read`、Python 同步/异步接口，导出 `experience-snapshots.json` 保存最终快照和各 Meta 操作实际绑定的历史输入。查询/读取 cursor 绑定 snapshot 和请求；单快照 4096 记录/12 MiB、卡片 2048 字节、回复页 64 KiB，超限明确报错。`trajectory` 暂时只报告 `not_captured`，尚未把引用或空列表冒充完整历史轨迹。

验证：完整 Python 391 项中 387 通过、4 跳过；随后卡片补充假设/理由的 7 项经验专项再次通过。严格 mypy 35 个公共文件及独立 I/O 模块、33 文件 Ruff/格式通过。第一批 TS 6 文件 66 项中 65 通过，暴露尚未评测的候选被错误要求生成经验的问题；修复后 2 文件 19 项通过，保持原报告/导出断言。最终固定源码后的 9 文件 82 项全部通过，包含 Project、研究/经验、实际 Codex 沙箱、源码冻结、Skill 发布和 Target diff。独立 npm/wheel DSH/Pi 旅程通过，覆盖 CLI、同步异步 SDK、socket、经验快照/资源 diff/导出一致性、CPU training 和实际 OS 隔离算法；本轮没有开启可选 Docker probe，也没有外部模型或 GPU 验证。最终类型/lint/格式、94 个 TS 模块边界、127 个公开运行时模块和生成合同通过；git diff --check 通过，README 修改/新增检查为空。未将此前完整 TS 回归的结果覆盖到这次修改。

## 历史轨迹内容读取迁移

历史经验的 `trajectory` 视图现在列出实际来源。Hitch 声明 canonical events 分页能力时，在接纳 seed 回执前读取并保存内容摘要；core 验证 artifact 属于实际回执槽位，重复、越界或状态/摘要矛盾均拒绝接纳。来源绑定原始 operation/receipt、run/candidate 和当前快照中的任务重复槽位；原始日志仍保存在 provider。修补执行覆盖旧来源，原材料投影不冒充新执行；复用 baseline 保留原始 run/candidate 身份，不依赖历史 Gear 目录继续存在。

Python `algorithms/trajectory.py` 负责查询规范化、筛选及 cursor 绑定和有界页投影；TypeScript 的封闭 adapter 注册表只负责受控 I/O、来源摘要和协议校验。CLI `experience trajectory`、控制器 `experience.trajectory` 和 Python `experience_trajectory/aexperience_trajectory` 都要求明确的快照与两级引用。页面最多 50 个事件/64 KiB，字段读取限定单个序号，cursor 绑定快照、来源内容摘要与筛选条件；损坏、漂移或越界不会通过重新评测修补。长内容使用 Hitch 的有界摘要，页面明确 `child_sessions: not-included`，不能推断子会话活动或资源未被使用。

内置 Codex 的独立 worker 提供每次操作专用的只读 UNIX socket，仅服务该快照的来源；没有 Project 控制方法，也不挂载 Hitch 私有目录。token、并发 4 次/总计 256 次限制、来源授权与通用错误均由边界执行；结束或取消会中断读取并关闭 socket。导出增加 `trajectory-sources.json`，保留操作者可见的读取器身份及全部历史快照引用的来源绑定，不复制完整日志。

验证：第一批 5 文件 38 项通过；补齐回执捕获、拒绝非法 artifact、基线来源和实际 OS 沙箱 socket 后，5 文件 83 项通过。追加 controller/export 来源损坏、操作结束中断正在读取的 provider、当前协议/命令测试后，另 5 文件 35 项通过（与前批部分重叠）。真实本机 Hitch CLI 读取合成 canonical session，分页、UTF-8 长字段摘要、内容摘要漂移及符号链接拒绝通过；没有模型调用或 daemon 任务。完整 Python 394 项中 390 通过、4 跳过；mypy 36 个公共文件及独立 I/O 模块、Ruff/格式 34 文件通过。独立 npm/wheel DSH/Pi 安装旅程通过，包括同步/异步 SDK 对越界轨迹的相同拒绝、来源导出、CPU training 和 OS 隔离算法；该旅程没有启用可选 Docker probe，没有 GPU 或外部模型验证。类型/lint/格式、102 模块边界、133 个公开运行时模块和生成合同通过；27 篇当前指南/协议的相对链接通过，README 修改/新增检查均为空，git diff --check 通过。本轮没有重新运行完整 TS 套件，不把先前全量结果覆盖到这些修改。

## 修改资源使用情况迁移

修改使用情况已接入新经验快照。纯 Python `algorithms/modification_use.py` 负责精确内容匹配、四种状态与按状态的有效成对试验汇总；`observations/hitch.py` 负责读取固定 manifest 列出的 DSH 原生 main/child 文件及已校验 Target 内容。TypeScript 只负责来源绑定、独立 worker、缓存和生命周期，不包含匹配决策。两套算法的六模块布局未改变，训练实现仍与命令行/部署探针分离。

来源固定在接纳 seed 回执时，逐文件核对摘要、字节数、会话身份与父子关系。仅 canonical 页面不能推出 `not-observed`；不支持的资源、删除文件、缺失日志、未配对或不匹配的内容保持 `unknown`。只有受支持 Skill 在全部清单来源中未匹配时才报告 `not-observed`。重复 ID、倒序/多重结果及保留上限造成的潜在歧义不能产生成功证据；完整的另一份来源仍可提供确定的正面观测。

整份快照的未缓存观测共享 1024 次来源读取/1 GiB 预算，Python 返回剩余额度供后续 worker 继续消费；worker 崩溃后不重新授予额度。完整来源且候选内容已校验时才保存可复用结果，按候选、变更、来源和实现身份寻址。来源移除后仍可使用已校验结果；部分/不可用来源在后续快照重试，旧快照保持不可变。读取进程支持取消与输出上限；manifest/缓存读取均有字节上限，特殊文件与链接不进入证据。

CLI/控制器及 Python 同步/异步 `experience_read` 增加 `modification-use` 视图，卡片与 task-results 展示状态计数。动作示例最多每资源 4 个、每试验 16 个，保留总数与省略数；只保留来源身份/序号及调用 ID 摘要，不复制正文。按状态的分数汇总只描述观测关系，不推断因果；Skill 元数据修改后的正文匹配不证明修改指令被执行。中英文结果指南、Codex runner 和发布协议已同步。

验证：新增 Python 16 项通过，完整 Python 410 项中 406 通过、4 跳过；首次从仓库根目录启动导致 probes 导入失败，改从 python 目录后完整重跑通过。mypy 37 个公共文件与 2 个独立 I/O 文件、Ruff/格式 37 文件通过。固定匹配源码后 TS 5 文件 43 项通过；追加缓存/manifest 有界读取和链接/FIFO 检查后，2 文件 11 项通过（与前批重叠）。独立 npm/wheel DSH/Pi 安装旅程通过，包括原生 child Skill 正文匹配、预算耗尽、来源漂移、CLI/同步异步 SDK 的新视图、CPU training 和真实 OS 隔离算法。实际本机 Hitch 合成 canonical session 的分页/摘要/链接拒绝再次通过。未开启可选 Docker probe，没有模型调用或 GPU 作业。类型/lint/格式、106 个 TS 模块边界、137 个公开运行时模块与生成合同通过。

第十八轮固定代码的完整 TS 回归通过：122 个文件通过、4 个文件跳过；1515 项通过、31 项跳过，约 585 秒，使用 2 worker，未放宽规模测试超时。随后补上读取视图每页的 `summary.conditioned_results`，使快照中已有的分组汇总直接通过 CLI/SDK/Meta reader 可见，并为该字段预留分页字节。该补充后 TS 2 文件 24 项通过，完整 Python 411 项中 407 通过、4 跳过，mypy 37 文件和 Ruff/格式 38 文件通过；独立 npm/wheel 安装旅程再次通过，包含同步/异步 SDK 对汇总字段的一致读取。TS 类型、106/137 模块边界和生成合同再次通过。

最终 I/O 审查又补齐实际读取计量：原生文件打开后先核对实际大小，逐行读取不超过清单剩余字节；候选资源即使摘要无效也消耗已读字节，不能因失败重获额度。新增两项故障验证后，Python 经验与原生观测共 26 项通过（其中原生观测 18 项），TS 2 文件 11 项通过，独立 Node→冻结 Python 观测探针通过；mypy 37 个公共文件及 2 个 I/O 文件、38 文件 Ruff/格式通过。这次末尾 I/O 修改没有重跑完整 TS 或重新安装包，不将前面的全量结果自动算作覆盖末尾改动。当前 26 篇指南/协议的相对链接检查及发布协议资源一致性通过，README 修改/新增检查均为空，git diff --check 通过。

## Verifier 过程观测与诊断迁移

新增纯 Python `algorithms/verifier.py`，负责 Hitch verifier 来源绑定、任务 reward 与独立 process score 一致性、组件权重/计数验证、失败代码假设、可用性和范围汇总。TS 只读取有界 Hitch CLI 结果、保存不可变来源并检查固定合同。Hitch 的 `verifier_evidence: "1"` 能力决定是否读取；每次最多 4 个并发 CLI、每个输出 8 MiB/30 秒。缺失/损坏/不支持的次级材料不破坏已认证任务零分，不能冒充过程零分。

算法 evidence 增加可选 verifier 投影。每试验至多 16 KiB，优先保留失败组件与 error 反馈，至多 32 个组件、16 条反馈、32 个失败代码，完整组件计数和省略数仍保留。私有引用、原始 result/diagnostics 不进入算法或 Meta；完整响应留在 operator receipt。代码只支持调查假设，不宣称根因。显式声明的 `verifier.*` metric/assertion 才进入原指标/保护合同；unsupported 与 invalid 状态继续保留。报告提供独立 process metric 汇总，完整槽位才给出任务加权值，部分观测均值单独标注。

经验读取增加 `verifier` 视图，CLI、Python 同步/异步 SDK 和沙箱 Meta reader 使用同一冻结观测。原始材料补取不会执行 Target，也不重写原 verifier 诊断；已认证的 result、过程和反馈不能被后续补取替换。连续补取还核对上一轮已保存来源，并保留本轮未读取的分组来源。中英文结果指南、算法索引、Codex runner、协议和发布资源已同步。

验证：Python 19 项 verifier/经验定向测试通过；完整 Python 424 项中 420 通过、4 跳过，严格 mypy 38 文件、Ruff/格式通过。TS 首批 5 文件 74 项通过，增加状态绑定后 7 文件 91 项通过；连续投影修复后 3 文件 63 项通过。真实本机 Hitch CLI 在临时合成 run 中读取独立过程分数、有效主零分并拒绝损坏组件，通过；没有模型或 daemon 调用。独立 npm/wheel DSH/Pi 安装旅程通过，包含 installed Python 正面 verifier 投影、CLI/同步异步 SDK 新视图、CPU training 和 OS 隔离算法；该旅程发生在连续投影修复之前，最终安装复测与完整 TS 回归待记录。类型/lint/格式、108 个 TS 边界模块、139 个公开运行时模块、生成合同及 28 篇当前文档链接检查通过，README 修改/新增检查为空。

第十九轮完整 TS 回归已通过：123 个文件通过、4 个文件跳过，1521 项通过、31 项跳过，约 559 秒，使用 2 worker。覆盖本轮 verifier、连续投影来源保护和此前最后的 native I/O 计量修复，未放宽规模测试超时。全部 140 个 Python 生产文件 Ruff/格式检查通过。

固定最终源码后的 npm/wheel DSH/Pi 安装旅程再次通过；这次将真实本机 Hitch CLI 的只读合成 verifier 探针也放在已安装 npm/独立 Python 环境中执行。CLI 与同步/异步 SDK 的 verifier 视图、CPU training、原生资源观测、OS 隔离算法继续通过；公开 API 导出与安装后 Codex runner 握手通过。没有开启可选 Docker scorer probe，也未调用外部模型或 GPU。最终 README 修改/新增与 diff 空白检查为空。

## DSH/Pi 原生容器行为验证

新增 `scripts/check-target-headless.mjs` 及固定依赖的测试 runtime，验证真实 DSH/Pi CLI 加载 adapter materialize 的资源、调用原生 bash、写入文件，再由独立容器中的实际 Gear 模板 verifier 评分。两种 adapter 的原载体均为有效 0 分，修改提示/扩展后的载体均为有效 1 分，四个场景全部通过。容器禁用外部网络，受控 chat-completions 服务只在容器内 loopback 运行，没有外部模型请求。该证据不等于完整 Hitch/Meta/认证模型闭环。

真实 DSH 测试暴露普通 Harbor 容器没有嵌套 sandbox 后端，原生 bash 因默认 `workspace-write` 被拒绝。已在固定的容器评测 patch 中配置 `danger-full-access` 与 `approval.policy: never`，由外层容器提供边界；宿主 prepare 载体不变，候选不可编辑该固定 patch。相关 Hitch、Target store 和 Skill 发布测试 3 文件 22 项通过。类型/lint/格式、108 个 TS 边界模块、139 个公开运行时模块和生成合同通过。

测试还发现上游 DSH `0.1.1-rc.2` 的 HMR 浮动依赖存在启动兼容问题；夹具锁文件固定 HMR `1.0.16`，不宣称已修复 Hitch 下载的未固定上游 artifact。验证命令、实际范围和依赖限制见[容器测试说明](testing/target-headless.zh-CN.md)。本次在 ARM64 宿主运行 AMD64 容器，源码探针报告保存于 `/tmp/gear-headless-proof-8/report.json`；测试容器与候选镜像已清理，输入 runtime 镜像保留供复现。

随后带同一 headless 容器验证的 macOS 独立 npm/wheel 安装旅程完整通过：使用已安装 adapter 和 Python benchmark 编译器，再次完成 DSH/Pi 四个实际工具/评分场景；原有 CLI、同步/异步 SDK、CPU training、OS 隔离算法、原生观测与真实本机 Hitch 只读 verifier 探针也通过。新增测试驱动语法、4 篇相关文档链接与 DSH 发布参考资源一致性通过。两套算法六模块布局一致，旧训练包目录不存在，README 修改/新增和 diff 空白检查为空。本轮没有重跑完整 TS/Python 套件；此前全量数字不自动覆盖本次容器配置修改。

进一步将 DSH 场景从修改提示文件改为直接修改 `plugins/policy.js`，以对应 Pi 的 extension 代码改动；真实 CLI、原生工具和评分的四个场景再次全部通过，报告为 `/tmp/gear-headless-proof-9/report.json`。本次补强发生在上述 macOS 安装旅程之后，未改 production adapter；前一份安装报告仍对应提示文件场景。

## Linux 发布安装验证

在原生 ARM64 Linux 容器（Node `22.23.0`、Python `3.11.2`、Debian bookworm）中，独立 npm/wheel 旅程完整通过。测试镜像只包含 npm tarball 展开的发布材料和独立测试驱动，没有 Gear 的 TS 源码或仓库 node_modules；wheel 从发布材料中的 Python 源码构建。覆盖实际 managed setup、doctor 的严格 seccomp/文件与网络隔离、DSH/Pi 项目流程、CLI/同步异步 SDK、CPU training、经验/研究档案及导入合同。此旅程使用离线 provider，没有认证模型、Hitch daemon、GPU 或容器内再次嵌套的 Target headless 测试。

测试容器作为独立受控 Linux 环境，授予 `SYS_ADMIN`、`NET_ADMIN` 并关闭外层 Docker 的默认 seccomp filter，以便内部 Gear sandbox 创建 namespace 和安装自身的严格 filter；没有宿主目录、凭据或 Docker socket 挂载。未修改 Gear 的隔离要求或断言。先前 AMD64 模拟环境在 `bwrap` 配置 loopback 时失败（`Failed RTM_NEWADDR: No child processes`），增加网络管理 capability 后仍未通过；只把原生 ARM64 结果记为通过。

发布旅程新增可选 `GEAR_TEST_NPM_PACKAGE` 输入，以直接安装已有 tarball，避免在只有发布文件的测试环境中重新执行源码打包 hooks。默认仓库旅程仍自行打包。Linux 的 Dockerfile/发布输入在 `/tmp/gear-linux-install-proof-1/`，通过日志为 `/tmp/gear-linux-install-arm-run.log`；本次运行容器和临时测试镜像已清理。原生 Linux 证据不能替代规范中的真人易用性实验或真实模型认证验收。

## 执行条件身份核对与验收审查

逐项核对结果已整理到[验收核对表](refactor-acceptance.zh-CN.md)。实际生成的 text/files 项目配置均为 8 行，无需手填 SHA/socket/compiler；真人首次使用与算法定位时间仍没有实测。

发现并修复 Hitch 只核对 revision/dataset、未核对实际模型与执行参数的缺口。新增 `adapters/hitch/conditions.ts`，对实际 inspect 的 request、resolution 和 result candidate 同时核验模型、harness、原生载体参数、环境变量名范围、attempt/并发/重试次数和超时，拒绝未声明的 inference/training 绑定。原材料补取也执行同一核验，未接纳回包不会形成 receipt 或触发重发；新模块进入 provider 的实现身份。

16 个错误条件在修复前全部复现错误接纳；修复后 Hitch、verifier、repair 三文件 79 项通过，追加原材料补取条件漂移后单项专项再次通过。真实本机 Hitch CLI 对 DSH/Pi 合成 eval 记录的只读 inspect 探针通过；这只验证实际读取协议，没有创建 daemon 作业或模型请求。类型/lint/格式、109 个 TS 边界模块、140 个公开运行时模块及生成合同通过。

最终独立 npm/wheel 安装旅程通过，包含安装后的新条件校验、真实 Hitch 只读探针、直接修改 DSH plugin/Pi extension 的四个容器工具与评分场景，以及原有 CLI/同步异步 SDK、CPU training、OS 隔离算法和导入合同。第一次旅程在可选 Docker 镜像查找阶段失败；随后本机确认镜像并按锁文件重建（得到相同 image ID），再次完整运行通过。没有把第一次失败计为通过。README 修改/新增、diff 空白检查为空；测试容器已清理。本次未重跑全量 TS/Python 或 Linux 安装旅程。

审查同时确认仍存在更深的实际执行身份缺口：顶层 npm revision identity 不包含后来准备的依赖闭包，当前跨 run baseline 尚未完整绑定 prepared artifact/controller runtime 和模型端点环境。Hitch daemon 使用自身的 credential environment，不能用 Gear CLI 进程的环境摘要冒充它。中英文配置指南已明确区分源码身份校验与完整执行环境证明；后续需要继续修复该合同，不能仅靠文档说明关闭。

## 共用 Hitch 环境观测与漂移校验

从训练控制器提取 provider 环境校验到 `src/adapters/hitch/environment.ts`，与项目评估共用；Hitch/training JSON 摘要集中到 `adapters/hitch/json.ts`，保留现有训练摘要调用入口。训练 placement 保留 checkout、远端 worker generation 和训练部署约束。没有引入第二份环境校验规则。

项目评估现要求 local execution observation v2，并绑定 fresh nonce、daemon instance、controller startup/current、Harbor 可执行文件和 Docker 引擎观测。稳定身份排除 nonce/daemon instance；相同实测环境重启后身份不变。新提交明确选择 `local-docker`，提交前与保存 receipt 前重新观测；inspect 的 plan controller runtime 和 execution provider 必须匹配。环境漂移不妨碍已有 provider 对象取消作业。环境证据保存进 receipt，原材料补取沿用原始证据，不重新解释成新环境执行。

验证：8 个新的错误观测/漂移案例在接入前复现失败，接入后通过；相关 Hitch/verifier/repair/onboarding 检查通过，训练 TS 全部 22 文件 165 项通过。类型、lint、格式、112 个 TS 边界模块和 142 个公开运行时模块、生成合同通过。真实 Hitch daemon + Harbor 0.21.0 + Docker 27.4.0 的 fresh observation 探针验证重复身份与错误身份拒绝，无 eval 作业、无模型调用（`/tmp/gear-environment-real-2.log`）。首次 detached daemon 启动超过 CLI 等待窗口；已改为管理自身前台进程并确认退出，旧探针遗留进程已清理。

独立 npm/wheel 旅程通过（`/tmp/gear-environment-package-2.log`），包含安装后的共用校验、真实零作业 Hitch 观测、DSH/Pi headless 容器与独立评分、CPU training、CLI/SDK、OS 隔离算法和导入路径。第一次旅程缺少测试用 verifier 镜像参数，未算通过；补全固定 digest 后重跑通过。之后补上 projection 环境证据保留，专项 1 项通过（`/tmp/gear-environment-projection.log`），类型/lint/格式再次通过；这项字段保留改动后没有重复完整安装或全量 TS/Python/Linux 检查。README 未改；自有 daemon 和测试容器已清理。

R1 仍未关闭：当前观测证明 controller/执行工具的观测身份，不能证明完整 prepared Target 依赖闭包、Harbor Python 依赖闭包、已加载模块或 daemon 模型端点环境。下一步需继续核对 Hitch prepared artifact 的可冻结来源与时机，并解决端点条件的实际证据，不能用 CLI 的环境变量摘要代替 daemon 的环境。

## Prepared artifact 回执一致性与真实准备证据

新增 `adapters/hitch/artifacts.ts`，交叉核对 plan/result 的 artifact ID、目录与入口完整性、revision/harness、任务覆盖、Linux 平台和 Node 合同，并核对每个 work item 的实际 artifact pin。相同平台的重复试验不能混入不同依赖；检查结果保存为 receipt 的 `execution_artifacts`，原材料补取保留根回执的原始绑定。新模块已进入 provider 实现身份。

12 个错误 artifact/任务/平台回包在修复前全部被错误接纳，修复后拒绝且不保存 receipt。Hitch、verifier、repair 和多平台 artifact 四文件 107 项通过；跨重复依赖漂移追加专项 1 项通过，已有两个外部提交不会被重发。真实 Hitch 公开 `buildEvalExecutionPlan` + CLI `eval inspect` 对 DSH/Pi 的合成记录检查通过。类型、lint、格式、113 个 TS 边界模块、143 个公开运行时模块和生成合同通过。独立 npm/wheel 旅程通过（`/tmp/gear-artifacts-package.log`），包含安装后的新模块与真实只读协议检查；未重跑上轮无变化的 headless、全量 TS/Python 或 Linux 安装旅程。

进一步使用 Hitch 0.2.16 的公开 `prepareHarborArtifact`、`ensureControllerRuntime`、`loadHarborArtifact` 实际准备 Linux ARM64 的 DSH 0.1.1-rc.2 与 Pi 0.84.1：重复准备命中相同 artifact ID，改写自有缓存入口后校验拒绝，还原后再次校验通过。没有创建 eval 或模型调用。报告及可复用缓存保留于 `/tmp/gear-prepared-artifact-proof-1/`；命令和验证范围见 [Hitch artifact 检查](testing/hitch-artifacts.zh-CN.md)。这证明公开 API 足以取得并复核真实依赖身份，普通宿主平台 `hitch prepare` 不能代替它。

R1 仍未关闭。本轮已封闭“回包 artifact 互相矛盾仍被接纳”的缺口；实际 artifact 的提交前冻结、与 baseline 条件绑定、以及模型端点身份还要继续接入。接下来可用上述公开 SDK 在预编译任务平台之后准备对应 artifact，并在 provider 身份/回执中核对同一绑定；SDK controller payload 和 Docker/Harbor 环境也必须匹配 daemon 观测，不能因 API 可调用就假设环境相同。DSH 完整启动的 HMR 依赖问题仍未在生产 artifact 路径解决。

## 提交前冻结真实 Target 产物

将连接观测、SDK 加载和产物准备分别放入 `adapters/hitch/connection.ts`、`sdk.ts`、`preparation.ts`。provider 连接时先检查实际 daemon 条件，再用同一 Hitch 安装的公开 SDK 编译全体任务的平台声明、准备各平台产物；产物目录/入口摘要与逐任务平台绑定进入 provider/evaluation identity。新物理提交前复核缓存文件，回执必须匹配连接阶段冻结的产物。SDK controller payload、Docker/Harbor 环境在准备前后均核对；同一进程不得在 Hitch 更新后继续使用缓存的旧 SDK 模块。doctor 保持只读，不触发构建。

可执行文件解析提取到 `adapters/process/executable.ts`，profile 创建与 SDK 加载共用，保留 PATH、相对路径与符号链接解析。新增 PATH 合同先复现 SDK 无法加载、随后修复通过。8 个受影响测试文件共 146 个独立用例通过（分批运行，重复运行的 onboarding 未重复计数），覆盖平台分组、任务覆盖、SDK 与 daemon 不同、准备失败清理、缓存升级、提交前漂移、回包与冻结产物不符，以及实际 provider 身份变化阻止跨 run baseline 复用。baseline 测试使用受控评估回执，不代表真实模型基线验收。类型、lint、格式、117 个 TS 边界模块、147 个公开运行时模块和生成合同通过。

生产 `HitchOperationProvider.connect` 已在真实 Hitch 0.2.16、Harbor 0.21.0 与原生 ARM64 Docker 上验证 DSH/Pi：重复连接身份稳定，改写自有缓存入口后校验拒绝，还原后通过。没有 eval 作业或模型请求。`/tmp/gear-freeze-native.log` 记录独立探针，产物复用 `/tmp/gear-prepared-artifact-proof-1/hitch`。新脚本与命令见 [Hitch artifact 检查](testing/hitch-artifacts.zh-CN.md)。最终独立 npm/wheel 旅程通过（`/tmp/gear-freeze-package-final.log`），包含安装后的同一真实准备探针、只读 Hitch 协议、CLI/SDK、CPU training、OS 隔离算法与导入/评分合同。本轮未重跑无变化的 headless 模型响应场景、全量 TS/Python 或 Linux 安装旅程；README 未改。

R1 仍未关闭：模型端点、Harbor Python 依赖与已加载模块没有完整证明；Hitch 提交仍自行选择产物，Gear 对错配结果拒绝接纳不等于执行前强制 pin。DSH 完整启动的 HMR 问题仍在。还需审查取消后的重新连接：当前恢复先绑定完整 provider，准备或身份漂移失败可能阻止清理旧作业；已有 provider 对象取消成功不能证明此路径可用。

## 环境变化后的独立取消恢复

复现了 5 个取消恢复失败：冻结 project/benchmark、Target 或 provider 启动条件损坏时，原路径先重建执行环境，无法到达停止协议；未提交的 run 也会被无关准备失败阻挡。现将取消连接与新执行分开：准入保存私有 `cancellation.json` 和摘要，恢复取消先于 benchmark、Target、算法、profile 与 provider 启动检查。Hitch 使用原 identity/request 的 sequence 1 pause；process 保留原输入与实现标识，不重新 describe。停止确认逐个尝试已提交操作，未确认时保留预留和计量，状态为 `needs_recovery`；缺失或损坏的快照不算成功。

CLI 现在主动完成停止确认；后台控制器持久化请求后中断正在进行的恢复连接，并独立确认原作业。已验证损坏 research、删除 profile/benchmark/Target、不再可用的算法 Python、恢复连接中断、损坏快照还原后重试，以及已启动的 Codex 模型可执行文件被删除后的实际进程退出。取消快照不进入 report 或 export。自定义 TypeScript bindings 的恢复端口要求、测试范围与命令见[取消恢复验证](testing/cancellation.zh-CN.md)。

全量 TS 回归 127 文件、1590 项通过，4 文件/31 项按环境跳过（`/tmp/gear-cancel-ts-all.log`）。类型、lint、格式、119 个 TS 边界模块、149 个公开运行时模块与生成合同通过。真实 Hitch 前台 daemon 的独立取消连接验证重复 pause、延迟 start 拒绝、零 eval 作业和模型请求（`/tmp/gear-cancel-real-control.log`）。最终 npm/wheel 安装旅程通过（`/tmp/gear-cancel-package.log`），包含新进程 CLI 的丢失输入取消恢复、安装后的真实 Hitch 停止协议、原有 CLI/SDK、CPU training、导入和 scorer 检查。本轮未重复无变化的全量 Python、headless 或 Linux 安装旅程；README 未改。

补充审查发现原生 Codex 的另一种故障需要继续处理：`job.json` 丢失时，当前 cancel 路径无法可靠区分“从未启动”与“已有执行但状态被删除”，其停止确认不能仅凭新的取消标记推断。独立连接修复不等于此类原作业状态丢失已被覆盖。下一步先对该场景做故障注入并加固确认，再继续 R1 的端点与实际模型条件验收。

## Codex 原作业状态丢失保护

故障注入复现了 3 种错误停止确认：移走 `job.json`、单个作业目录或整个控制目录时，旧实现仍返回取消成功，而暂停的 worker 和模型子进程尚未停止。现新增 `adapters/codex/journal.ts`：新运行准入单独初始化 `operations.json`，提交和模型启动都先登记。inspect、submit、cancel 只读取既有命名空间；缺失/损坏登记表或已登记的作业文件丢失时保持 unknown/未确认，不能重建为新工作。取消不再依赖 `started.json` 是否存在；登记过的执行需要持久结果与执行锁释放。

通用 provider 增加可选 `prepareAdmission`，process describe 通过 `admission: true` 选择 `prepare_admission` 协议。此步骤仅在新运行创建时调用，先于私有取消快照和 run journal；预览、doctor、普通恢复与独立取消连接都不调用它。模型启动记录也在运行级登记表内，因此单独丢失启动标记不能让重复 worker 再次调用模型。目录记录损坏仍需调查/还原；本修改不宣称自动找回丢失的数据。

相关 4 个文件 74 项测试通过（`/tmp/gear-codex-loss-tests-final.log`），覆盖 4 类状态丢失、启动标记丢失、强杀后重复 worker、正常取消/恢复，以及新准入步骤不进入 preview/resume。初次混合回归漏设 `GEAR_TRAINING_TEST_PYTHON`，41 项因 Python 配置失败；补齐后全部通过，没有把该失败计为通过。独立 npm API 安装探针通过（`/tmp/gear-codex-loss-api-package.log`），验证安装后的协议、只读 describe、目录缺失拒绝和 pre-start fence，零模型调用。类型、lint、格式、120 个 TS 边界模块、150 个公开运行时模块与生成合同通过。

完整离线 npm/wheel 安装旅程通过（`/tmp/gear-codex-loss-project-package.log`），包含 CLI/同步异步 SDK、DSH/Pi 项目流程、CPU training、独立取消恢复、OS sandbox 算法以及导入/评分合同。本轮未重跑无变化的全量 TS/Python、真实 Hitch、headless 或 Linux 安装检查；README 未修改。后续继续 R1 的生产 DSH 依赖启动与实际执行条件证明；外部模型验收输入仍待提供。

## 默认 DSH 运行组合与真实产物启动

使用先前保留的未改动 Hitch artifact 再次复现 DSH `0.1.1-rc.2` 的启动失败：浮动依赖安装到 HMR `1.0.19`，启动器需要的 `registerConfig` 方法缺失（`/tmp/gear-dsh-native-start-1/stderr.log`）。默认 Target 现选择 DSH `0.1.5-rc.3`；其发布包自身固定 HMR `1.0.17`，无需修改 Hitch、篡改缓存或添加兼容 shim。普通 headless 夹具同步版本并删除原 `1.0.16` override，锁文件已更新。已有 profile 和历史运行身份不改写。

准备探针与生产 preflight 探针统一读取当前运行矩阵。新增 headless 的真实 artifact 模式：读取准备报告、匹配版本和平台，在执行前后通过公开 `loadHarborArtifact` 验证缓存，再将产物只读挂载到候选容器。Node 与实际 CLI 版本都必须匹配，报告区分真实 Hitch artifact 与普通 npm 夹具安装。候选及 verifier 的平台分别取实际镜像架构；两者都禁用外部网络。

真实 Hitch `0.2.16` 的 ARM64 产物准备/完整性检查通过（`/tmp/gear-dsh-native-pinned-prepare.log`）；生产 provider 的 DSH/Pi 重复连接、稳定身份和篡改拒绝通过（`/tmp/gear-dsh-native-preflight.log`），零 eval/模型请求。使用这些未改动产物的四个 headless 场景通过（`/tmp/gear-native-headless-matrix-1/report.json`）：DSH/Pi 各自的基线和扩展修改都实际调用原生 bash，独立 verifier 分别给出有效 0 和 1。候选为 ARM64，verifier 使用现有 AMD64 Python 镜像；受控 SSE 服务只在各候选容器的 loopback 监听，无外部模型请求。

相关 onboarding、Hitch、准备及发布清单 4 文件 69 项通过（`/tmp/gear-dsh-default-tests.log`），含默认 DSH profile 的精确版本；类型、lint、格式、120 个 TS 边界模块、150 个公开运行时模块及生成合同通过。移除 override 后的 ARM64 普通测试镜像已构建成功。四个普通镜像场景也通过（`/tmp/gear-fixture-headless-matrix-1/report.json`），证明更新后的锁文件无需测试专用修补。

最终 npm/wheel 安装旅程通过（`/tmp/gear-dsh-default-package.log`），含安装后生产 preflight、真实 artifact 的四个 headless/独立评分场景、CLI/SDK、CPU training、取消恢复、OS 隔离与导入/评分合同。报告和执行范围见 [Target headless 验证](testing/target-headless.zh-CN.md)。本轮未重跑全量 TS/Python、AMD64 候选或 Linux 安装旅程；README 未改，自有 daemon、候选/评分容器和派生镜像均已回收。可复用 artifact 缓存 `/tmp/gear-dsh-native-pinned-1/hitch` 和普通测试 runtime 镜像保留。R1 的端点环境与依赖证明、外部模型输入仍未完成，HMR 修复不能作为完整真实模型闭环验收。

## 当前交付与验证边界

生产搜索、排名、固定投影和训练决策已经迁入 Python；GEPA 与 RandomSearch 采用相同的六模块结构。旧执行装配及其回归夹具已按用户后续要求删除，历史源码由 Git 保留。训练按 `gear.training` 的存储、运行时、后端、流水线和 CLI 分层，旧包与转发入口已删除。

DSH、Pi 使用同一 benchmark 摘要和同一 Python GEPA 实现身份，分别完成了真实 Luna 的 baseline → 诊断 → 修改 → 候选评分 → 独立 held-out gate。两者各复用 1 次历史 seed 基线，refine 新执行 3 次，种子题和留出题均从 0 分变为 1 分。具体范围和证据见 [Luna 验收](testing/luna-live.zh-CN.md)；这只是小型合同验收，不是完整 benchmark 的效果结论。

以下范围未纳入本次实测或不作保证：

1. [执行条件绑定](refactor-acceptance.zh-CN.md#r1执行条件绑定与验证边界) 已覆盖 daemon 环境、helper 输出、实际 Python 文件、支持的环境文件与执行前 artifact 约束；未声明文件、动态范围外资源、全系统共享库和并发主机修改不构成不可变快照。应使用稳定依赖环境并声明自定义文件，不追加完整主机快照作为本次重构前置条件。
2. AutomationBench 官方固定数据的全量运行、资源协议 v2 的原生目录导出及 GPU 作业没有纳入本次验证；已完成的合成 Harbor/Compose、CPU、真实小型 Target 测试只证明其明确覆盖的范围。
3. 规范 U1/P1 的真人首次使用和算法定位时间尚未测量。用户回复“不需要模拟了”，因此不模拟，也不填写虚构完成率。

状态：本次代码重构、搬迁整理和初步功能验证已完成，以上边界如实保留；不声称全部产品验收项均已实测。用户后续要求清理旧实现夹具、推送同名分支并向 `dev` 提交 PR；最新清理结果见文末。README 未修改。真实 Hitch 路径需要配套 `codex/gear-evaluation-binding` 分支提供环境绑定 v3 与产物 pins v1，不能仅安装当前发布的同版本号包替代。

## 2026-10-12：luna 真实调用与接入修复

- 用户指定 luna 后，使用本机独立 Codex 0.145.0 与现有认证。gpt-6-luna 返回不支持该登录的明确服务端错误；gpt-5.6-luna 分别完成 Pi 和 DSH 候选生成。DSH 的重连 inspect 与同 operation 重复 submit 复用原回执，事件文件不增加。反馈为人工构造的 seed 失败，不能当作实际 benchmark 的模型改进效果。
- 实际运行发现并修复 macOS `/etc` 别名下不存在文件的权限拒绝；系统 CA PEM 与可选 code-mode companion 加入身份与读权限，保持 TLS 验证及严格网络隔离。Meta 不加载应用连接/插件。原生 process 期限从固定 30 秒改为生成期限加 30 秒，避免生成仍在期限内时提前失去连接。
- 新增显式真实模型探针 `scripts/check-codex-live.mjs`，不会由普通测试自动调用。诊断日志：`/tmp/gear-luna-meta-56.log`；DSH 可重跑脚本证据：`/tmp/gear-luna-meta-live-1/report.json`。前期拒绝/失败记录分别保留，未计为通过。
- 为完整 Hitch 测试准备新的 AMD64 DSH/Pi artifact，缓存命中与篡改拒绝通过，证据 `/tmp/gear-luna-live-artifacts-1/report.json`。实际 Project 准备又发现输出目录冲突：编译器要求创建新目录，但调用方传入已创建的临时目录。现在传入临时根下尚不存在的 dataset 子目录，并清理整个临时根；专门回归先复现失败再验证修复。
- DSH/Pi 的真实 Hitch Target 单题执行均完成，分别得到 1 条有效 1 分证据。两者进一步分别完成 Python GEPA 一轮真实优化：复用独立 run 的基线，seed/held-out 从 0 分变为 1 分，独立 gate accepted；每轮 refine 新执行 3 次，4 个逻辑槽位均有效。benchmark 摘要与 Python 实现身份相同，实际修改分别落在 Pi 的 AGENTS.md 和 DSH 的 prompts/system.md。上述进展没有关闭 R1 的端点环境边界。
- 原生 Codex 提交等待还有一个回执发布/释放锁竞态：释放检查后再次读取回执，避免把已完成操作误报为 unknown。相关 5 个文件 47 项通过、2 项跳过；此后回执修复另经 24 项 Codex 回归。最终类型、lint、格式、依赖边界和生成合同通过；独立 npm/wheel 安装旅程通过，见 `/tmp/gear-luna-package.log`。详细版本、实际运行范围和证据见 [Luna 验收](testing/luna-live.zh-CN.md)。README 未修改。
- 本轮最终全量 TS 回归：127 文件通过、4 文件跳过，1601 项通过、31 项跳过，耗时约 625 秒（`/tmp/gear-luna-ts-all.log`）。Python 实现未改，未重复全量 Python 单测；Ruff、140 文件格式、38 文件公开类型检查及基础 wheel/CPU 旅程通过。两个真实搜索闭环的 8 个自有 eval 均无运行中容器，临时 Hitch daemon 已停止；回执、项目和 artifact 缓存保留供核对。

## 2026-10-12：实际 daemon 环境绑定与 Luna 复验

在独立 Hitch worktree 的 `codex/gear-evaluation-binding` 分支实现环境绑定生产协议，Gear 现在显式要求相应能力。绑定来自真实 EvalScheduler 的驻留环境，包含模型、变量名和一次性取得的 helper 输出；root 私有 HMAC 不公开端点或凭据值。helper 输出继续沿私有传递通道交给 Harbor，不在执行时刷新。新准入与 Harbor 启动前验证原绑定；回执必须携带同一 ID。缺失、改动和过期拒绝；幂等查询、恢复和取消保留原作业语义。

Gear 四个文件 89 项通过，Hitch 四个文件 74 项通过；两边类型及架构检查、Gear lint/格式/生成合同通过。新协议下 Pi/Luna 完成 Python GEPA 的 baseline → 诊断 → 修改 → 独立 gate：seed/held-out 均 0 → 1，复用 1 次历史基线，新增 3 次实际评估，无无效槽位。DSH/Luna 的真实 baseline 与同绑定复用预览也通过；本轮 DSH 未重复完整搜索。五次 eval 的实际请求绑定均核对一致，289 个指定输出文件未发现原始访问令牌；自有 daemon 停止，五次 eval 无残留容器。

独立 npm/wheel 安装旅程通过，包含安装后真实零作业绑定探针。实现依赖、runtime ID、各 run ID、失败尝试及通过范围见[环境绑定验证](testing/hitch-environment-binding.zh-CN.md)。没有重跑未变化的全量 Python、全量 TS、Linux 或 GPU；不能把前次结果当成本轮新增覆盖。配套 Hitch 尚未发布，原始两个 checkout 未修改，README 未改。R1 的完整 Harbor 依赖闭包与执行前 artifact pin 继续处理，目标仍在进行。

## 执行前 Target 产物约束（2026-10-12）

配套 Hitch 新增 `evaluation_artifact_pins: "1"`。Gear 按当前任务组的平台提交冻结的产物 ID、目录与入口摘要；Hitch 在准备结束及每次 Harbor 执行前强制核对，原值进入持久请求与幂等身份，恢复和重试不重新选择 pins。Gear 继续核对回执中的原请求、计划、结果和 work item。该改动关闭上一节保留的执行前产物约束缺口；Harbor Python 与环境引用文件的完整证明没有因此完成。

相关 Gear 合同 96 项、artifact 6 项、入门流程 8 项通过；Hitch 合同 75 项、CLI 13 项通过。类型、lint、格式、依赖边界、生成合同与独立 npm/wheel 安装旅程通过。安装后的实际 ARM64 DSH/Pi 缓存探针验证错误 pins 在 Harbor 调用前被拒绝，零模型请求。两个新项目分别通过 Luna baseline 与复用预览，实际 pins、准备产物和 work items 一致；未重复完整 GEPA。详细版本、日志、run ID、首次失败与最终验证范围见[产物约束验证](testing/hitch-artifact-pins.zh-CN.md)。README 未修改，配套 Hitch 尚未发布。

## Harbor Python 文件身份（2026-10-12）

配套 Hitch 的环境绑定升级为 v2，纳入实际 launcher 的 Python、虚拟环境配置、模块路径文件、启动时加载模块和 Python 共享库。文件按内容读取，检查期间的增删和改动拒绝；同版本依赖修改产生新绑定，旧绑定在 Harbor 调用前拒绝。正常字节码缓存验证与源码一致后视为派生文件，避免普通缓存生成使基线失效。检查程序进入 npm 产物与 controller runtime，不读取包自报的 integrity 作为证明。

Hitch 五个文件 56 项与其中调用的 Python 七项检查通过，Gear 两个相关文件 74 项通过；Hitch 构建、架构检查以及 Gear 类型、lint、格式通过。首次控制器清单回归发现两处固定文件数需随新增检查文件更新，修复后通过。独立 npm/wheel 安装旅程通过，DSH/Pi 的 Luna baseline 与复用预览均通过；两个实际请求绑定同一 Python 内容身份，并匹配各自的产物。115 个指定输出文件没有原始访问令牌，两次运行无残留 eval 容器，自有 daemon 已停止。完整范围见[Python 内容身份验证](testing/hitch-python-runtime.zh-CN.md)。本轮未重跑无变化的全量 TS/Python、Linux 或 GPU；原 checkout 和 README 未修改，目标仍在进行。

## 环境文件绑定与交付收尾（2026-10-12）

环境绑定升级为 v3，增加标准证书/凭据配置及显式声明的自定义文件身份；同路径内容变化、默认文件出现、链接目标或模式变化都会改变绑定，准入及 Harbor 执行前拒绝原身份。清单只存私有 HMAC；helper 的 Target 路径不会被当成主机文件读取。修正 Python `safe_path` 版本差异，明确拒绝外置字节码缓存。详细文件范围、限制和测试见[环境文件绑定](testing/hitch-environment-files.zh-CN.md)。

最终相关回归：Gear 两文件 74 项通过；Hitch 六文件 64 项通过，包含 Python 清单的 8 项测试，系统 Python 上另跑同一清单 8 项也通过。Gear 类型、lint、格式、依赖边界、生成合同通过；Hitch 构建、语法和架构检查通过（443 个源码文件、952 条跨模块边）。发布清单检查确认两个新增运行文件被打包。

独立 npm/wheel 安装旅程通过，日志 `/tmp/gear-environment-files-package.log`：真实零作业 daemon 的环境文件内容变化/恢复身份验证、原生 DSH/Pi 产物完整性与错误 pins 拒绝、安装后 setup/doctor、CLI/SDK、CPU training、取消恢复、OS 隔离、CSV/JSONL/Harbor 导入和 Python scorer 均通过。该旅程使用离线 provider 与真实评分器，不作为新增模型闭环证据；此前真实 Luna 的版本和运行范围继续按原记录保留。

更新的六份验收/指南文档相对链接检查通过；两处工作树的 README 修改及新增均为零，`git diff --check` 通过。所有本轮命令已结束，探针按自身清理流程关闭 daemon；保留可复用的原生产物缓存。代码重构与初步验证收尾，不新增发布、推送或真人模拟步骤。

## 清理旧回归夹具与过期测试（2026-10-12）

按用户后续要求，删除旧 staged-search、RefineService、Meta 执行装配和 Python 策略夹具，以及 61 个只验证这些实现的 TS 测试文件、3 个专属 Python 测试文件、无引用的 helper、旧 canary/shadow/schema 脚本。移除 `tsconfig.fixtures.json`、独立夹具编译与输出目录；Vitest 全局 setup 仅构建当前生产入口。旧 V1 身份夹具目录中的 README 按用户限制原样保留，其余代码资源删除。

保留并调整仍有价值的覆盖：沙箱生命周期、进程锁、资源保留/释放、普通复制与克隆回退、隔离区崩溃恢复、断言状态矩阵直接测试生产模块。删除 CI 中依赖旧执行器的 DSH rc.2 与 Hitch rerun 专项；当前 Project/Hitch 测试、Python worker/Codex 隔离、安装旅程继续运行。贡献指南、算法作者入口、测试命令和文档链接同步；历史源码引用固定到重构前 Git commit，不指向已删除目录。

清理后全量结果：TS 69 个文件通过、1 个跳过，615 项通过、3 项跳过（`/tmp/gear-cleanup-vitest.log`）；Python 402 项，其中 4 项跳过（`/tmp/gear-cleanup-python.log`）。CI 规则 14 项通过；类型、lint、格式、生成合同及双语言边界检查通过。公开 npm API 安装检查和独立 npm/wheel 旅程通过，后者覆盖 DSH/Pi、CLI/SDK、CPU training、取消恢复、真实评分器及 OS 隔离（`/tmp/gear-cleanup-package.log`）。未重复模型调用或 GPU 作业，原有 Luna 证据保留原版本范围。

README 的修改/新增检查为空，`git diff --check` 通过。推送目标是 Gear 的 `codex/project-refactor`，PR 基线为 `dev`；配套 Hitch 尚未发布，其要求在 PR 中明确说明。
