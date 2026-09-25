# 作者 SDK 实施状态

实施依据：[v4 方案](algorithm-author-sdk-plan-v4.zh-CN.md)与[作者合同](algorithm-author-sdk-authoring-v4.zh-CN.md)。本文记录实际交付，设计文档中的 API 示例不自动成为已支持功能。

## 已提交

- `1025093`：A0 双语言作者运行层。支持惰性受管理调用、普通 async 顺序流程、自定义 workflow 与嵌套 parallel、冻结观察、不可变 checkpoint、同一 Campaign 的冷重放及源码身份校验。安装导出为 `rsi-gear/algorithm/author` 与 `gear_algorithm.author`。
- `97e938f`：冻结性能对照工具与第一份失败基线。正式复测报告单独保存，不覆盖失败记录。

主审验证：类型检查通过；8 文件、79 项相关回归通过，覆盖两种语言真实 controller SIGKILL 后原 key 恢复；Python SDK 40 项中 37 项通过、3 项可选 Optuna 测试跳过；仓库外 npm 安装与 Python wheel 导入通过。独立 reviewer 的功能结论及证据见 [A0 审计](experiments/author-a0-functional-review-20260926.zh-CN.md)。

## A1.1 双语言合同切片

新增显式 `gear.author.replay.v2`，定义 HarnessAgent、TaskSelection、RoleResult、ProposalBatch 和 Evaluation 的公共数据合同。`ctx.role` 与 `ctx.tasks.sample` 已生成对应的正式 operation 意图并验证返回结构；具体服务装配仍在下一切片。配置 schema 在第一次意图之前校验，TS 普通 `interface` 配置可直接使用。只读结果可以原样传入 workflow、checkpoint、operation 和 result；Python 提供 snake_case 属性访问。

两端共用 36 个 DTO 正反例，并通过真实 Python worker 的三次重放对照。Python 将 v2 的有限安全整数值统一为 int，允许 JSON `2.0` 用于 `range`，保留科学计算的小数值，拒绝 bool 及越界整数。数据结构校验不代表模型调用或评估产物已获得物理验证；这些检查属于通用宿主。

独立复审结论为本片段无剩余功能阻塞，见 [A1.1 审计](experiments/author-a1-contract-review-20260926.zh-CN.md)。主审另外验证了 4 文件 47 项受影响回归，以及仓库外 npm/Python wheel 安装和既有跨语言 worker 接线。类型 fixture 使用仓库相对导入，仅证明 API 类型可组合，不作为外部作者试用通过的证据。

## A1 历史候选输入切片

`src/history/nonwinner.ts` 可以从明确的旧实验目录读取 rejected / rejected-for-substrate round 中的 sealed 候选，并在新 CAS 中建立 Harness 引用、binding 与来源记录。它验证原始 JSON 字节、旧 schema、Git commit/tree/不可变 ref、实际单一父提交、修改范围与 manifest 文件闭包；读取旧数据不调用旧 runtime，也不继承预算、未决操作或 measurement。

当前仅支持新 profile 固定使用同一个物理 Git 仓库。新 CAS 必须与旧 state、原仓库及 Git common dir 分离；跨仓库搬运尚未实现。patchDigest 仅保留原记录，不声称重新构造验证。独立 history/state 回归 3 文件 44 项通过，见 [历史读取审计](experiments/author-a1-history-reader-review-20260926.zh-CN.md)。真实阿里云旧候选的导入探针及后续构建/执行仍分别验收。

## 当前限制

A0 是运行基础。`propose/evaluate/select`、任务采样的真实 provider、通用运行 profile、五文件作者项目及新的 CLI 仍待后续 A1 切片；现有 A0 role/edit/rollout/measure 便利方法用于探针，v2 已拒绝这些假 operation。用户不能仅复制 v4 的搜索示例便运行真实实验。

性能按冻结标准报告：TS 的两个代表性轨迹通过每前沿额外 100 ms 门槛，Python 在 `97e938f` 上仍为 125.15/114.09 ms，未通过；冷恢复通过。进程树峰值内存目前只有抽样证据，上界未验证。见 [正式复测](experiments/author-a0-benchmark-97e938f-20260926.json)。未选择产品默认前沿上限，长流程门尚未验证。

A0 每次重放受 1 MiB 消息/历史与 256 KiB checkpoint 限制，超限明确失败；分页、大输出分块、自定义 archive schema 及完整依赖闭包支持尚待后续阶段；本片段的配置 schema 支持不等于这些能力已完成。源检查用于已知不支持用法的诊断，不能当作任意作者代码沙箱。

## 阶段验收

| 阶段 | 状态 |
| --- | --- |
| A0 功能基础 | 已提交并独立审计 |
| A0 性能/历史盘点 | 真实历史格式清单已保存；Python 性能及 RSS 门未关闭；盘点不等于历史导入通过 |
| A1 最小作者切片 | 实现中；真实 Hitch、外部作者体验、跨语言 provider 和非 winner 起点分别验收 |
| A2 历史读取/复用 | A1 已有狭义非 winner Harness 导入；报告、经验、模型制品等完整格式覆盖待实现 |
| A3 统一宿主与内置接口 | 待实现 |
| A4 RHO/长期流程 | 待实现 |
| A5 训练适配 | 待实现；CPU 合同与真实权重/GPU 验证分别报告 |
| A6 FCS 迁移与发布 | 待实现；保留原 35 项差分科学语义门槛 |

旧实验读取兼容、FCS/RHO/GRPO 等价、真实训练和新 SDK 发布均未因 A0 功能提交而宣布通过。
