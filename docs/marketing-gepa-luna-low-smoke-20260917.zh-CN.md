# Marketing 10 题：DSH + Luna low 算法实测

已完成所选 10 个 marketing 任务的实测：原生 DSH Target 与 Meta 均为 Luna low。算法完成基线、失败聚类、两次候选生成、局部评测、bridge、全量 seed 和拒绝门禁；本轮没有产生更优 champion。实测发现并修复了两处 Gear 问题。

## 固定测试条件

- Target：原始 DSH harness，`@deepseek-ai/dsh` 0.1.1-rc.2，`openai-codex/gpt-5.6-luna`，`reasoningEffort: low`。
- Meta：原生 DSH，同样使用 Luna low；不启用 context offloading，启用独立的持久化请求预算。
- 算法：`failure-cluster-gepa-v1` 默认策略，1 轮、最多 2 个候选；独立 held-out 晋升门禁，不放宽分数要求。
- 预算：40 个新 rollout cells，300,000 个 Meta tokens，80 次 Meta 请求；单任务 15 分钟，评测并发 4。
- Hitch：现有 0.2.10，直接 CLI 模式。没有修改 Hitch CLI。OAuth 由 Gear 已有 wrapper 注入，不进入检查沙箱。
- 使用标准 AutomationBench marketing 数据集；10 个任务按固定种子 `marketing-gepa-luna-low-10-20260917` 和任务 ID 的 SHA-256 顺序抽样，8 seed + 2 held-out。
- 任务文件和评分器逐字节校验一致；两个分区不重叠。没有根据本次结果重新选题。

| 分区 | 任务 |
| --- | --- |
| seed | marketing-campaign_attribution |
| seed | marketing-email_campaign_analytics |
| seed | marketing-event_followup_personalization |
| seed | marketing-hashtag_performance |
| seed | marketing-lead_enrichment |
| seed | marketing-newsletter_unsubscribe_processing |
| seed | marketing-social_crisis_response |
| seed | marketing-twitter_influencer_followup |
| held-out | marketing-competitive_response_plan |
| held-out | marketing-newsletter_sponsor_invoicing |

原始 harness 提交为 `b4ce3003290ac1668efbea722d11c6981d501c77`。在单独的测试仓库中，仅把固定模型载体的推理档位由 medium 改成 low，再重新封装 manifest。固定载体为 `4135a46d7fcf7dce2385a52a9135e3a2251253be`，初始 champion 为 `055d157303830d60bc3968de6a2fe3804e3c7f07`；可修改 harness 文件的初始摘要保持一致。

## 测试结果

| 分区 | 原始 harness 完全通过 | 候选 0 完全通过 | 原始过程得分 | 候选过程得分 |
| --- | --- | --- | --- | --- |
| seed（8 题，算法正式比较） | 2/8 | 2/8 | 74.68% | 72.03% |
| held-out（2 题，补充冒烟检查） | 0/2 | 1/2 | 59.94% | 66.67% |

seed 通过率保持 25%，过程得分下降 2.65 个百分点。晋升决策为 rejected，原因是 process-regression 和 no-substantive-improvement，原 champion 保持不变。候选 0 的局部通过数为 2/3、bridge 为 2/4；候选 1 局部为 1/3，并以 bridge-capacity 留在研究档案。局部收益没有转化为全量 seed 的改善。

算法共执行 **19 个新 rollout cells，全部有效**：基线 8、两个局部候选合计 6、bridge 补 1、全量 seed 补 4。没有重复执行本轮已有的同一 harness / task cell，128 个不可变对象摘要核验通过。两次 Meta 共 12 次请求、208,675 tokens，summary 请求为 0；实际会话记录确认始终为 Luna low。

预算账本按两份候选硬上限保守结算 300,000 tokens / 80 requests，不是实际模型消耗；实际用量单独记录如上。评测、请求和 token 上限均未突破，账本没有待结算操作。

seed 门禁拒绝后，算法没有启动正式 held-out 晋升评测。为完成选定 10 题的覆盖，额外使用同一 Hitch、模型与两个固定 harness 提交，对剩余 2 题分别运行基线和候选，共 4 次有效评测。它们单独存档，不写入原算法 journal、不改变门禁、不用于宣称候选应晋升。最终覆盖 10 个独立任务，共 23 次有效评测、0 次无效评测（前述两次环境准备失败另计）。因此，本次覆盖了真实拒绝路径，**没有验证真实 held-out 晋升接受路径**。

正式 evolution：`a07e8af6-9bc1-46c4-b551-3cbe4c32fb66`；候选 0 提交：`92a5904f4852a12c1968a3b7446b9e7476b251e0`；代码包摘要：`sha256:fbf87910ea0fa243d42d5bcff4280c9eb3c6039a65c9c5654591ace982e0bbf4`。

| 任务 | 原始 harness outcome / process | 候选 0 outcome / process |
| --- | --- | --- |
| marketing-campaign_attribution | 0 / 86.67% | 0 / 80.00% |
| marketing-email_campaign_analytics | 1 / 100.00% | 1 / 100.00% |
| marketing-event_followup_personalization | 1 / 100.00% | 0 / 54.55% |
| marketing-hashtag_performance | 0 / 94.12% | 0 / 83.33% |
| marketing-lead_enrichment | 0 / 50.00% | 0 / 72.73% |
| marketing-newsletter_unsubscribe_processing | 0 / 27.27% | 0 / 27.27% |
| marketing-social_crisis_response | 0 / 72.73% | 0 / 58.33% |
| marketing-twitter_influencer_followup | 0 / 66.67% | 1 / 100.00% |

## 环境问题及处理

1. 首次提交被 Hitch 的 `dirty_source` 检查拒绝：测试仓库中 `node_modules` 是符号链接，原 `.gitignore` 中的目录规则没有忽略它。只在新测试仓库的 `.git/info/exclude` 添加 `/node_modules`。该次没有执行任何模型评测。
2. 第二次完成了 8 个有效基线评测、2 次 Meta 候选提案，但候选检查失败：Homebrew Node 的外置动态库不在沙箱允许读取的范围。切换为独立 Node 24.19.0，并通过固定 `compiler.readPaths` 允许读取 Target 符号链接指向的依赖目录。保持 required 沙箱，未放开网络或通用目录权限。
3. 修正后先单独运行真实 DSH compiler 检查，验证加载、prompt assembly、清理和候选摘要，再创建新 evolution。旧 evolution 及其失败证据保持原样；启动脚本已加入这个前置检查。

第二次环境失败的基线为 2/8，Meta 实际消耗 10 次请求、136,564 tokens。它们与最终测试分开统计，不能作为候选比较时的替代基线。

## 实测发现的 Gear 问题

Meta 的轨迹诊断把汇总 StageResult 的摘要当作 Hitch 单次评测 ID，与真实 verifier 的 parent.evalId 比较，导致有效证据被误报为 corrupt。失败聚类使用的原始证据和 benchmark 分数有效，但这会降低 Meta 可见的诊断质量。

修复位于 Gear 的 EvaluationSearchAdapter、HitchTrajectoryReader 和 RefineCapabilities：从冻结的 seed StageResult 及已验证的 cell 来源恢复物理 eval、trial 和 attempt。拒绝不属于该投影的 run、held-out 投影及身份不匹配，不放宽 Hitch 校验。回归测试也覆盖第二个逻辑 repetition 对应物理 attempt 1 的情况。

使用本轮原始 3 条轨迹进行只读验证：修复前均为 corrupt，修复后均为 complete，且 observation 有效，分别恢复 14、12、15 个 process components。该验证没有新增 rollout 或 Meta 请求。结果在实验目录的 verifier-fix-replay.json。

已完成的整轮保留原打包快照，没有热替换候选或改写旧证据；最终 benchmark 结果反映该快照生成的两个候选。修复后的诊断读取路径由上述真实记录验证和回归测试覆盖。相关 159 项测试通过，1 项真实日志测试因未配置专用夹具跳过；类型检查、构建和 diff 检查通过。

另一个显示问题是候选已完成构建、进入评测后，candidateGeneration 仍报告 generating。构建成功时现在持久化 ready 状态；真实工作区的阶段流程测试覆盖该转换。它不改变评测结果或晋升决策。

## 本地复核材料

实验目录：`.evolve-lab/marketing-gepa-luna-low-10-20260917/`（本地忽略目录，不包含在源码提交中）。

- `prepare.mjs`、`request.json`、`config.json`：抽样、冻结配置和代码包摘要。
- `run.mjs`、`check-compiler.mjs`：原生 DSH 启动及真实沙箱前置检查。
- `audit-inputs.mjs` / `input-audit.json`：数据、配置、代码包和初始 harness 核验。
- `audit-results.mjs` / `result-audit.json`：终态证据、实际请求、预算和重复调用核验。
- `state/`、`hitch-home/`：原始 Gear journal、Hitch 评测及轨迹证据。
- `attempts/`：前两次环境失败的独立记录。

本实验用于验证小规模真实运行。一次低推理档位的抽样结果不足以证明稳定的泛化提升，也不覆盖 daemon、Skill Meta 或多轮恢复路径。
