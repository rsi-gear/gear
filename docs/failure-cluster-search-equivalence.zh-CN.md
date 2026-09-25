# FailureClusterSearch 的 Campaign 重写与等价验收

状态：确定性差分、本地完整 Search 回归及阿里云功能门禁已通过；真实 TB2.1 三轮实验正在运行。基准为 `ec76b8b25703c46cbe3b2aaf94b64dc0c2277921` 的旧公开 `FailureClusterSearch`。

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

## 2026-09-25 验收记录

Campaign 路径已通过 35 项冻结旧实现差分，包含最终结果、物理调用、预算、故障恢复与时钟边界；另有阶段钩子差分验证 scope-preparation、generation 等公开观察点的预算和执行顺序。纯 science/archive 检查点改为已提交决定的持久投影，实际评估、诊断、生成、修复、research checkpoint 与发布仍按操作合同执行。

公共 `FailureClusterSearch` 入口现已切换为 Campaign facade，RefineService 的运行与修复入口封存同一个 service hook 实现身份。故障恢复中的两个 science checkpoint 发布窗口已修复；闭包扫描、状态差量和证据索引优化保留摘要、物理调用顺序和原错误边界。

最终入口源码快照在 macOS / Node 26.5.1 / npm 11.17.0 下通过 29 个文件、342 项 Search 测试，无跳过或失败。其中包括 35 项冻结旧实现差分、原 1500ms generation deadline（约 1.67 秒完成测试）、原 1000-task / 1700-cell 用例（约 58.68 秒，保留 90 秒门槛）。额外持久化/provider 聚焦验证 46 项通过；丢失第二次 process projection 回复后，恢复保留原 key 且不重复第一次 projection 或 rollout。TypeScript、构建、安装后 Search 示例恢复，以及 TS/Python/跨语言作者包验证通过。

阿里云正式安装 Gear `6fe2c4a6fdb96e6a8775b0da0ca656a0ea0d0ea2`，核对相同 223 个源码文件的摘要，使用隔离的 Node 26.5.1，未替换系统 Node。该环境下原百任务四种 adapter 组合均通过，约 14–16 秒；功能门禁选中的 75 项全部通过：原 D05 1 项、冻结差分 35 项、时钟恢复 7 项、过期 bootstrap 1 项、science 冻结恢复 2 项、持久化/provider 框架 29 项。筛选命令之外的用例不计入通过数。

服务器千任务测试仍触发原 90 秒时限（测试报告约 90.48 秒），保留为已知性能限制。此前 Node 22 的两种百任务组合和千任务时限也未通过，这些结果不计入通过项；未放宽任何测试时限。

真实实验配置为 TB2.1 固定 10 个任务全部用于搜索和同集评估、3 轮、meta/target 均为 `openai-codex/gpt-6-luna`、reasoning effort 为 medium。Hitch 最终升级至 dev `cadf2d747b5877b0b4feeaf089f3258a37db475b`（0.2.15）。旧 Meta 登录过期的问题已通过同账户的有效服务器登录解决，并将凭据隔离到本次运行目录；旧 Codex CLI 0.153.2 返回 Luna 不支持，独立安装的 0.157.0 已用同一 Luna 型号完成真实 MCP 预检。

正式运行前的部署失败保留为独立记录，不计为算法效果：第一批次因 Hitch 包内 `node_modules/smol-toml` 的 npm hoist 布局不满足运行包规则而在 planning 失败，0 trials；第二批次因声明必传但未设置 `NODE_OPTIONS` 而在启动前失败，0 trials；第三批次 10 个 trial 均因旧 target 不认识新模型而无效（`UNKNOWN_MODEL`），没有有效分数。

Hitch 的隔离安装已补齐原锁定的 smol-toml 1.8.0，900 个运行包文件哈希通过；必传代理变量已与原服务器配置对齐，Meta 身份封存实际 Codex CLI 0.157.0 的版本和原生二进制摘要。Target 使用新的隔离 carrier：通过 pnpm `patchedDependencies` 将官方 pi-ai 0.87.1 中的 `gpt-6-luna` 单条定义回补到 0.84.4，未升级 pi-ai、dsh-codex 或其他依赖。补丁仅插入 776 字节，原 7 个模型定义保留；root 与 dsh-codex 解析到同一个 patched 实例。旧 provider 传输加新模型定义的最小真实调用已成功，Gear 隔离 compiler 的加载、提示组装和清理通过；原 harness 无 Skill，Skill 项明确未检查。Hitch 准备的 artifact 也确认包含相同补丁。

新 target 基线为 `2a6ce4dcdcbc2e3e269dfea3664211748028cdb3`，基底为 `2d80e60201a22409442d31f22c0c1df14b079549`；其 harness 提示、工具、工作流内容与原基线相同，仅固定依赖目录和封存身份改变。补丁 SHA-256 为 `fb5cbf41e6802267f5ae78d4286e927b4dc54a6f5bd84a7d9776cccf0ba43306`，锁文件 SHA-256 为 `92594fb1d41b5e80192e43eb0b64021675c22bd76c46af993d35365d564bbc8e`。

第四批次 evolution `221fef3a-37e1-4fb6-b587-e8cb759bcd77` 的 10 个 target 均因 Hitch 0.2.14 不接受 DSH v0 的 `request/context` 而在轨迹导入时报错；虽然原始会话已有模型生成事件，结果仍全部无效。已保存证据并正常取消最后一个尚未结束的 verifier。最新 dev 0.2.15 的上游修复恰好覆盖此兼容问题：保留 v0 元数据原文并标为扩展事件，同时将私有运行目录移出封存 bundle。39 项相关测试、运行包哈希和 doctor 均通过，使用独立安装目录重新启动实验。

第五批次 `5a7c43bb-9157-413e-b4d5-5638402828a8` 已消除轨迹错误，但 10 个 trial 因评分接线无效：原生 Harbor 只返回 `rewards.reward`，手动创建标准 manifest 并不会补齐所需的 `rewards.total_score`。原始结果包含 0 和 1，均保留但不计入算法分数。

最终数据集改用 Hitch 官方 `harbor-package@6` 编译流程。十个任务的 41 份题目、测试和解答文件逐字一致；Harbor 1.1→1.4 迁移的所有执行字段相等，实际预构建镜像内容 ID 相同。原始 Dockerfile 和配置保存在包的 `source-files`，原有模型预算保持不变；官方编译器给外层执行守卫增加 660 秒清理/导出宽限。Python bridge 通过原 `reward.txt`/`reward.json` 和固定映射产生相同数值的 `total_score`。独立 0/1 合成验证均通过真实 bridge 与 Hitch 评分捕获，无 issue；真实 Luna 单任务预检 `eval_32bdd637220f4f58917f3a892748a075` 也成功，`regex-log` 得到有效标准分数 0。该预检不计为三轮算法实验。最终十任务数据集摘要为 `sha256:7e1610f0863597262b63f37b34c7622beb68ff90fc965af1d644d8ef5f0bbece`，原 `pass_rate = (totalScore == 1)` 指标定义保留。

旧状态目录保留五个失败批次。修正后的实验使用独立状态目录：旧实现 `ec76b8b` 与当前实现均会在初始化时尝试恢复所有 failed Search rounds，多于两个活跃恢复项会触发 Meta session 槽位上限。本次记录这一既有边界，未修改恢复行为以绕过等价要求。

截至本次记录，完整三轮实验已重新启动；五个部署失败批次与单任务预检均不计入算法分数，尚无完成三轮后的效果结论。
