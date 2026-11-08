# Titanic / MLE-bench：Gear 策略与 Hitch 执行边界

Gear 定义实验策略、优化 harness；Hitch 执行并校验完整任务流程。Gear 使用通用 provider 接口提交、查询、取消和收取结果，不包含 Titanic/MLE-bench 专用执行模块。`examples/mle-bench/` 仅保留初始 `harness/`。

## 职责与配置归属

| 内容 | 归属 | 修改规则 |
| --- | --- | --- |
| 官方数据、官方 train/test、私有答案、评分标准 | Hitch 的 benchmark 任务定义 | 遵循任务合同；候选不能改写 |
| CV 方法、折数、种子、shuffle、本地验证比例、实验额度 | Gear 项目的版本化实验配置 | Gear 创建新版本并在准入时冻结；通过通用接口传给 Hitch |
| 特征、模型、调参方法、实验选择策略、提示词与工作流 | 可编辑 harness | Meta 可以优化；受固定外层评估合同约束 |
| harness 生成、比较、晋升、外层优化预算与运行恢复 | Gear 通用优化控制层 | 不解析任务内实验、行划分或训练状态 |
| 数据准备、任务内实验序列、具体行划分、训练、CV、评分、refit、导出 | Hitch benchmark 包与固定 runtime | 执行冻结配置、验证证据并强制资源限制 |
| 任务内 checkpoint、实验记录、来源、执行身份、预算结算和恢复 | Hitch | Gear 只保存不透明引用及通用分数、成本、证据 |

Benchmark 逻辑属于 Hitch 的独立 benchmark 包，不进入 Hitch 通用调度器。Hitch 不导入或调用 Gear 的优化算法，不代替 Gear 决定晋升哪个 harness。

## 调用关系

```text
Gear 项目：任务引用 + 实验配置版本 + 初始 harness + 外层优化预算
    ↓ 通用 provider：describe / submit / inspect / cancel
Hitch：冻结任务与配置 → 生成并持久化划分 → 执行候选的完整实验流程
    ↓ 通用 OperationReceipt：分数、成本、证据、产物和恢复引用
Gear：比较相同外层评估身份的 baseline 与候选 → 晋升 / 下一轮优化
```

使用现有 process provider 协议连接 Hitch 的 benchmark provider。Gear 不导入 `agent-hitch/analysis`，不构建分析任务内部请求，也不维护 `integrations/analysis-research`。Hitch 可输出通用项目配置、provider profile 与任务描述，调用方通过 Gear 现有 API/CLI 登记并运行；Hitch 自身不依赖 Gear 安装。

## 版本化实验配置

Gear 项目的 provider configuration 持有完整实验配置。示意：

```yaml
experiment:
  version: validation-v1
  maxExperiments: 5
  validation:
    method: stratified_kfold
    folds: 5
    shuffle: true
    seed: 42
```

配置版本与内容摘要绑定。Hitch 拒绝同一版本对应不同内容，拒绝未知字段、未支持算法、与任务合同冲突的配置，以及候选覆盖外层配置。初始兼容配置仍是五折；新接口支持参数化的 K-fold/分层 K-fold（2–10 折）与本地留出比例，不把五折固化在新协议执行器中。

Hitch 基于配置和已认证数据生成逐行分配，记录配置摘要、数据摘要、算法版本、行 ID 和 fold/训练验证分配摘要。生成结果作为不可变执行输入持久化。所有对照候选使用同一外层分配；恢复校验并沿用原分配，不能重新随机抽取。

新版本配置建立新的实验身份和 checkpoint。五折改十折、种子或比例变化后，baseline 与候选都重新评估；旧成绩保留，禁止直接混排或合并成同一可比较集合。Gear 通用 provider 配置身份在 admission/resume 时冻结，Hitch 再校验任务内部身份。

优化“内部验证策略”与修改共同外层评估是两种不同操作。当前候选不能覆盖共同外层配置；若以后开放不同内部 CV，必须在共同、固定的外层评估下比较最终解法。新增 group/time 等算法需要先扩展 Hitch 执行和校验能力，不能由配置绕过能力边界。

官方 test 与私有答案仍受 benchmark 合同约束。研究用划分只从获准的训练数据派生，带独立实验身份，不改写官方 train/test。

## 迁移范围

| 现有实现 | 最终位置 |
| --- | --- |
| `integrations/analysis-research` 内的 prepare、sequence、project、预算、checkpoint、report、refit、export | Hitch `benchmark-packages/kaggle/research/` |
| operation provider、target carrier、driver、实验工具、执行请求与校验 | Hitch benchmark 包 |
| Python worker、CV、隔离、固定评分 | Hitch `integrations/analysis-runtime/` 的唯一源码 |
| MLE 数据导入、grader 与比赛定义 | Hitch benchmark 包 |
| Gear 的分析专用 CLI、导出项、optional peer dependency 与配套运行逻辑 | 删除；复用现有通用接口 |
| 任务专用测试、fixture、运行文档和容器验收 | 随执行组件迁到 Hitch |
| Gear examples | 仅初始 `harness/`，无 CLI、测试、worker、scorer 或流程控制器 |

研究中的训练工具与 sealed refit 使用同一认证 runtime。允许部署时复制经摘要校验的构建产物，禁止维护第二份执行源码。Target 会话内每次 fit 不创建嵌套 Hitch eval。

## 行为、预算与恢复

- 保留旧协议的逐折指标、均值、utility、OOF、失败与实验槽计数语义。新参数化协议显式版本化，不改写旧协议。
- 最终方案按最后实际选择确定，不替换为历史最高分。研究结果只引用已有验证证据，不追加隐式训练或独立测试分数。
- refit 使用冻结源码和已选参数，仅拟合一次，不搜索、不调用模型。导出只复制该次封存预测。
- Gear 负责外层优化额度及配置版本；Hitch 负责执行额度预留、资源强制限制、真实消耗结算、任务内 checkpoint 和恢复。
- 丢失回复、重复请求、中断与到期收取沿用原执行身份；不能增加模型采样、拟合或重置额度。取消必须停止工作或留下可靠启动栅栏。
- 私有答案仅供独立 verifier；模型文本不能替代执行证据。Hitch 不读取 Gear 私有优化日志，只消费通过接口明确授权的候选资源与请求。
- 旧 checkpoint、receipt、runtime 身份保持原样。旧项目使用原绑定版本读取/执行；不静默重绑定新 runtime 或新验证方案。

## 验收

1. Gear 生产代码与发布包没有 Titanic/MLE-bench/analysis-research 执行实现或对分析包的专用导入；examples 仅初始 harness。
2. Hitch 单独安装即可准备任务、执行、恢复、refit 和导出，不依赖 Gear 或相邻源码 checkout。
3. 两个发布包通过 Gear 原有通用 provider 接口完成对照、恢复、结果收取与晋升；Gear 不解析任务内记录。
4. 配置支持五折、十折、种子和比例；同版本漂移拒绝，新版本隔离，baseline/候选使用同一外层划分；恢复逐行分配字节不变。
5. 确定性行为对照和真实 Linux 容器检验评分、数据隔离、资源限制、拟合次数、实际选择及零模型 refit。
6. 中断、丢失回复、取消、预算耗尽和旧 checkpoint 回放不产生额外执行或身份重写。
7. AutomationBench、Terminal-Bench 与 Gear 通用 provider 回归通过。明确区分测试替身、真实容器证据与外部模型运行。

基线：Gear `44d5bf0190103fa05c0bff8f38398cbcbcdfe2eb`，Hitch `6a6c7ec1eaf0865d27d9007fbf725b106df68828`。这版取代此前“Gear 保留任务内研究编排”的划分。


## 实现与验证记录（2026-11-08）

- Gear 的分析执行入口、研究控制器、固定 runtime、任务测试和 fixture 已迁出。发布包中的 `examples/mle-bench/` 只有 28 个初始 harness 文件；提示词从 `task_inspect` 读取验证参数。
- Hitch 提供 `hitch-analysis`、任务内 operation provider 与完整执行生命周期。Gear 生产代码只调整通用 process handshake：Hitch 声明公开 trajectory reader 配置，Gear 在 admission 时绑定自身实现摘要，恢复仍须严格校验冻结身份。
- 新任务使用 `analysis-task@7/@8`、`analysis-round-cv-plan@2` 与 `analysis-experiment@6`。旧协议、25 份历史实验记录及 checkpoint 保持可校验。新版逐行划分跨恢复和同配置轮次固定；换配置版本生成独立 checkpoint。
- Hitch 研究测试 64 项通过，覆盖版本漂移、五/十折、种子、shuffle、holdout 比例、范围隔离、预算、取消、丢失回复与导出。
- 两个 tarball 在独立目录通过真实 process 协议、Gear Python GEPA、比较、晋升和恢复测试。Hitch 单独安装可准备数据、固化执行器和导出声明式项目，无 Gear 运行依赖。
- 真实 Linux worker 验证五折、十折与 holdout；执行时禁用重新抽样函数仍可完成。安装包端到端运行完成 20 次十折研究拟合，丢失回复恢复未增加拟合，正式 Hitch eval 完成 1 次冻结 refit，导出绑定实际所选方案。决策来自确定性测试脚本，未调用外部模型。
- Gear 全量回归：893 通过、8 跳过，1 个代理测试首轮失败后单独复跑通过。Hitch 全量回归：1005 通过、18 跳过，新增公开导出的旧清单断言已修正并复验通过。Hitch 任务/发布重点测试、两仓架构检查、类型检查、Gear lint/合同检查均通过。
- Gear 全量格式检查仍报告原有 `src/application/trajectory.ts`；已核对该文件与 HEAD 相同，本次没有修改。验证未运行生产模型。

运行使用方式见 Hitch 的 `docs/analysis-research.zh-CN.md`。本地详细日志保留于 `/tmp/gear-hitch-boundary-task/`，重点为 `installed-both-current-2.log`、`installed-interface-final.log`、`workflow-canary-current.log`、`research-final.log` 与两仓全量回归日志。
