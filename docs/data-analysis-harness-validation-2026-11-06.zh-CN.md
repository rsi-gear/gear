# 数据分析 Harness：首版实现与 Titanic 验收

Gear 与 Hitch 已实现 `analysis-five-rollout@1` 的单任务研究链路：同起点分支、每个 harness 五次顺序实验、逐步选择封存、C5 开发评分、共享集晋升、历史合并、续跑和精确源码导出。模型 token/请求次数按用户要求不设硬上限，记录可观察 usage；实验机会和 wall/CPU 等资源预算继续执行。

入口见 [使用说明](../examples/data-analysis-harness/README.zh-CN.md)。完整运行身份、每步假设/结果、选择、产物摘要和成本保存在 [机器可读验收记录](data-analysis-harness-validation-2026-11-06.json)。本次方法修改由操作者预登记；真实 Target 使用模型生成训练代码，比较使用真实 Gear search engine。未把预登记修改称为自主 Meta 发现。

## 实现范围

Gear 新增通用数据分析 carrier、固定五折 worker、研究 checkpoint/CAS、五槽调度、预算与恢复、审计、迁移曝光账本和 strict refit。Search 增加显式 seed-only 证据复用，核验同一任务与计分条件；不以额外 held-out run 重复抽样。可编辑范围是通用提示、技能与 Python 研究/记忆/选择策略，训练脚本单独封存为 solution。

Hitch 新增 `sealed-python`、`--no-model` 与 eval request v2（`model:null`）、`sealed_source_execution=1`、`bounded-tmpfs@1`、普通 analysis task producer 和固定 verifier。既有模型请求、Kaggle pipeline 示例、eval/verifier/artifacts 公共接口保留。Gear 不读取 Hitch 私有存储布局来认证产物。

## 实验条件与比较

真实 Titanic 数据按既有划分使用 713 行内部训练、178 行开发评分；每个实验执行同一份按行 ID 锁定的五折。模型为 `openai-codex/gpt-5.6-luna`。Linux arm64 镜像按 OCI digest 固定，2 vCPU、4 GiB；每条序列最多 1800 秒、2400 CPU 秒、150 次工具调用，包含最终无模型 C5 交付。

先由模型完成一次共同 bootstrap，然后从同一个 checkpoint 分叉比较：

| 方法 | 精确 commit | 新实验数 | 实际 C5 开发准确率 | 事后 oracle | 选择损失 |
| --- | --- | ---: | ---: | ---: | ---: |
| H0 初始方法 | `e7aa7760e8b8ad1daf05feb686d92f3d046a3c0c` | 5 | 137/178 = 0.769663 | 139/178 = 0.780899 | 2/178 |
| H1 受控消融与证据摘要 | `a1198e28e3576c51860ded2468701f787186ceb9` | 5 | 138/178 = 0.775281 | 138/178 = 0.775281 | 0 |

H1 的通用修改要求读取当前源码，根据历史限制和各折波动提出可证伪假设，每次只做一个受控消融或正则化改动。模型据此自行提出删除稀疏姓氏信号；内部 pooled accuracy 从 570/713 升到 571/713。后续模型自行检验票号证据权重、组大小阈值和特征消融，没有注入预写 Titanic pipeline。

| 槽位 | H0 本次 V 的内部 CV | H0 当时选择 | H1 本次 V 的内部 CV | H1 当时选择 |
| --- | ---: | --- | ---: | --- |
| 1 | 0.798036 | 共同 C0 | 0.800842 | H1-V1 |
| 2 | 0.799439 | 共同 C0 | 0.800842 | H1-V1 |
| 3 | 0.799439 | 共同 C0 | 0.800842 | H1-V1 |
| 4 | 0.798036 | 共同 C0 | 0.800842 | H1-V1 |
| 5 | 0.798036 | 共同 C0 | 0.798036 | H1-V1 |

两条实际 C1–C5 的开发评分曲线分别恒为 0.769663 和 0.775281。H0 的另一个候选事后评分更高，但它没有成为当时的 C5，因此未用于主评分或导出。Gear 的真实晋升结果为 `accepted`，证据标记 `shared-set-research-seed-evidence`，额外 held-out 执行数为 0。一行的开发集差异不足以说明统计稳定性或 Kaggle 提升。

## 合并、续跑与导出失败

阶段 1 合并两条分支及共同祖先，得到 11 条研究记录；未晋升分支和无增益结果全部保留。阶段 2 使用 H1 从该新 checkpoint 继续五次实验，得到 16 条记录，C5 仍为 H1-V1。

第二阶段的 V3 删除了 title/class 交互，CV 下降；V4 根据这一结果改为缩小权重，仍不如 incumbent。这是模型根据前序反馈调整假设的实际轨迹。该阶段只有一条分支，没有计算 harness 增益。

随后精确 refit 在官方 test 输入的空 `Fare` 上失败：旧生成源码直接调用 `float('')`。原失败 run `run_d508ebdac03e420381e8452a74108541`、源码、异常与成本均保留，不能使用基础设施 repair 免费改写模型。失败导出现在也会结算成本，重复命令返回同一失败证据。

阶段 3 另行预登记 H2 `d4339221d4e3d2a5ae36a2327fe1e9b688ae897b` 和完整五次实验预算。通用修改要求数值缺失/未知类别下预测有定义，并允许 CV 持平时选择最近验证的维护版本。Target 自行修复源码；五步内部 CV 为 0.800842、0.800842、0.800842、0.798036、0.800842，实际选择为 V1、V2、V3、V3、V5。C5 开发评分为 138/178。这也是单分支续跑，仅用于验证研究和交付，不作为 H2 优于 H1 的配对证据。

阶段 3 的封存后审计覆盖全部六个候选方案；五点曲线与 oracle 均为 138/178，选择损失为 0。额外五次审计训练没有调用模型，未改变已经封存的选择。

三阶段后公共 checkpoint 保留 21 条研究记录和 21 个研究成本事件。审计、开发评分与 refit 结果另行保存，不导入 Target 研究历史。16 条记录的 checkpoint 已完成源码/OOF 完整导出、经 Hitch 公共产物认证后再导入，CAS 引用不变。

## 最终产物

最终使用 H2 实际 C5：`sha256:a2c20aedeea9bcbbd0cd23b5d3593f8d7c88ddfd579f9a3d61642a907087f10c`。固定执行器为 Hitch commit `bd2fb1c099e71ad7f91f8d51c64682bdafff6de6`。

在 891 行完整 train 上重训后，run `run_b7620a6896dc495fa61a418b417d2781` 导出 [submission.csv](../tmp/analysis-titanic-20261106-v2/finalization/submission.csv) 和 [refit.json](../tmp/analysis-titanic-20261106-v2/finalization/refit.json)。CSV 为 `PassengerId,Survived`、418 行、预期 ID 各一次、合法二元标签；摘要为 `sha256:45e7b7dcd211c8566861d05acd8e29d806e324d3e245996ec91bababf9e62daf`。模型请求为 0，重复导出返回相同 run、receipt 和文件摘要，没有再次训练。没有 Kaggle test accuracy，也未上传 Kaggle。

## 验证与证据边界

- 新协议测试 21 项通过，覆盖五次顺序实验、分支历史、失败占槽、非单调选择、预算截止、审计恢复、失败导出结算/并发/幂等、完整 checkpoint 与曝光账本。
- Gear seed-only 与既有评估适配相关测试 51 项通过，类型检查通过。
- 原 Hitch 构建和密封执行/运行时/资源测试 43 项通过；原 Kaggle producer 测试通过。
- 原 Gear Kaggle 回归 11 + 23 项通过。其中 macOS compiler sandbox 测试在允许本地 socket 的环境中复核通过。
- 真实 Docker canary 验证了五折与 OOF、伪造分数无效、文件/标签/凭据隔离、网络/fork 禁止及 CPU、wall、内存、输出限制；另有真实 Hitch 无模型合成任务成功。

阶段 1 的两次基础设施交付故障均保留旧 run 并各计入 600 CPU 秒保守消耗，没有重抽 Target。模型 token/请求 usage 是可观察下界，价格为 unknown；研究、审计、失败及部署成本分列于机器记录。

本研究项目累计记录 217 次模型调用、2,597,171 tokens、169 次工具调用；worker CPU 账面为 1204.205214 秒，其中 1200 秒是上述基础设施故障的保守记账。各操作 wall time 累计 4959.312 秒，不等同于并行任务的日历耗时。开发前的工程试跑和合成 canary 不计入这一研究项目，也不用于候选选择。

当前实现新增了私有输入/producer/scorer 的执行绑定、完整训练/test 输入绑定，以及阶段决策的内容寻址。它们在本次联调中补齐；完整输入绑定已逐项核对两次原始 refit 请求，原 receipts 未改写。阶段 1、2 的原路径式决策事件也未重写，另有内容快照。实际 Target commits 早于模板最后增加的 OOF 分页工具和有界 policy-error 处理，后两项有独立测试，不能说它们已在这些旧 commit 中真实执行。

本次没有验证自主 Meta 宿主的完整隔离闭环，也没有运行未曝光的跨任务迁移 suite。开发划分此前已被使用。沙箱限制资源和数据访问，不能单靠系统隔离证明任意生成算法不存在语义泄漏或未声明的训练。这些边界不改变已记录的 C5 和交付结果。
