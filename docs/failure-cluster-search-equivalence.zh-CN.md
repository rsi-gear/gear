# FailureClusterSearch 的 Campaign 重写与等价验收

状态：实施中，尚未通过完整等价验收。基准为 `ec76b8b25703c46cbe3b2aaf94b64dc0c2277921` 的旧公开 `FailureClusterSearch`。

## 验收目标

在相同 admission、组件、任务、初始 archive/champion、时钟、外部反馈和故障注入下，新实现必须保留旧实现的科学决策、公开返回值/错误、资源预算、物理操作及其恢复行为。科学阶段由新 Algorithm/Campaign 决策与细粒度 OperationProvider 执行，不能用一个 operation 调用旧整轮 `run` 冒充重写。

测试 oracle 保存在 `tests/helpers/frozen-failure-cluster-search.ts`，只机械修改相对导入和类名。旧 SearchExecutionRuntime、SearchJournal 与纯科学策略在重写期间保持独立，不修改旧 oracle 使测试通过。若必须调整共享依赖，须先冻结对应旧依赖，重新审查比较边界。

内部 Campaign 日志格式不要求与旧 SearchJournal 相同；公开 journal 投影、原始外部 key、消耗规则和提交顺序需要保持。跨实现身份的旧不确定运行继续使用原封存 runtime，不可凭迁移新建外部执行；这与新实现自身中断后恢复的等价验收分开。

## 必须覆盖的行为

| 范围 | 等价合同 |
| --- | --- |
| 准入与 bootstrap | 原公共调用合同；无 archive 首轮、有效 baseline、失败 bootstrap 不安装父代 archive；任务/组件/回归 suite 校验 |
| 父代与任务范围 | 内置和自定义 parent policy，包括 requiresChampion；stable/periodic epoch、共享任务、历史 specialist、pending completions |
| 候选计划 | 同样的诊断、聚类、假设去重、任务抽样、局部 baseline、候选 ID、配额与边界规则 |
| 多阶段评估 | local/bridge/global-seed/held-out 的相同计划、process mode、objective 初始参考；任何不足证据不得被静默过滤为另一条搜索路径 |
| 晋升与输出 | 同样的 stage decisions、reason codes、完整 SearchRoundOutcome、剩余预算与 research archive；保持 advisory 模式 |
| 跨轮反馈 | 自动生成和传递 ResearchFinding；从失败 seed cell 收集回归任务提案；held-out 信息不得进入研究输入 |
| 预算与时间 | round/evolution 预算及 timeout；缺省生成预算保持 null/未限制语义；只按原合同计费，不把未知用量当实测零 |
| 修复与补全 | 独立 repairEvaluation、消费前后边界、原运行 process/raw-metric 投影、partial completion、standalone archived evidence completion |
| 发布与恢复 | archive CAS → champion CAS → terminal 顺序；保留冻结 intent、原外部 key；丢回包、冲突、中断不新增非幂等副作用 |

Campaign 是新路径的资源记账权威；旧预算/进度如需对外保留，必须由已封存结果投影，不能再次 reserve 扣费。物理 provider 的 inspect 保持只读。对旧合同已要求幂等的同一冻结 champion CAS，若需要重放，应使用显式的通用幂等重放能力，不能伪称操作从未启动，也不能扩展到未知模型请求或 rollout。

## 分阶段交付

1. 冻结旧 oracle，建立独立差分矩阵与公开结果比较。
2. 并行 Campaign facade 跑通空 archive、bootstrap 与无候选完整终态，使用真实细粒度评估与发布操作。
3. 补齐候选全流程、objective、findings、回归提案、可选预算和跨轮行为。
4. 完成修复、补全、超时/取消、CAS 冲突与丢回包恢复。
5. 通过差分矩阵和旧 Search 全套回归后，替换公共 FailureClusterSearch 入口；复验服务接线、构建和包外入口，更新 PR。

每一阶段由实现代理冻结文件，主代理审查和独立复验后提交。中间阶段不宣称完整等价。最终报告必须区分确定性行为验收、真实物理接线和未经验证的模型效果。

## 2026-09-25 中间验收记录

Campaign 路径已通过 35 项冻结旧实现差分，包含最终结果、物理调用、预算、故障恢复与时钟边界；另有阶段钩子差分验证 scope-preparation、generation 等公开观察点的预算和执行顺序。纯 science/archive 检查点改为已提交决定的持久投影，实际评估、诊断、生成、修复、research checkpoint 与发布仍按操作合同执行。

这还不是完整验收：原公开 Search 的 1500ms generation deadline 测试仍失败，当前公共入口尚未替换。服务器的 TB2.1 实验也尚未启动。修复必须保留原时钟与测试门槛；通过后再记录公共入口全套回归、构建与包外验证结果。
