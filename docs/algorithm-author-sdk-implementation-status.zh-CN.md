# 作者 SDK 实施状态

实施依据：[v4 方案](algorithm-author-sdk-plan-v4.zh-CN.md)与[作者合同](algorithm-author-sdk-authoring-v4.zh-CN.md)。本文记录实际交付，设计文档中的 API 示例不自动成为已支持功能。

## 已提交

- `1025093`：A0 双语言作者运行层。支持惰性受管理调用、普通 async 顺序流程、自定义 workflow 与嵌套 parallel、冻结观察、不可变 checkpoint、同一 Campaign 的冷重放及源码身份校验。安装导出为 `rsi-gear/algorithm/author` 与 `gear_algorithm.author`。
- `97e938f`：冻结性能对照工具与第一份失败基线。正式复测报告单独保存，不覆盖失败记录。

主审验证：类型检查通过；8 文件、79 项相关回归通过，覆盖两种语言真实 controller SIGKILL 后原 key 恢复；Python SDK 40 项中 37 项通过、3 项可选 Optuna 测试跳过；仓库外 npm 安装与 Python wheel 导入通过。独立 reviewer 的功能结论及证据见 [A0 审计](experiments/author-a0-functional-review-20260926.zh-CN.md)。

## 当前限制

A0 是运行基础。`propose/evaluate/tasks/select`、通用运行 profile、五文件作者项目及新的 CLI 仍属 A1；现有 A0 role/edit/rollout/measure 便利方法用于探针，尚未连接真实服务。用户不能仅复制 v4 的搜索示例便运行真实实验。

性能按冻结标准报告：TS 的两个代表性轨迹通过每前沿额外 100 ms 门槛，Python 在 `97e938f` 上仍为 125.15/114.09 ms，未通过；冷恢复通过。进程树峰值内存目前只有抽样证据，上界未验证。见 [正式复测](experiments/author-a0-benchmark-97e938f-20260926.json)。未选择产品默认前沿上限，长流程门尚未验证。

A0 每次重放受 1 MiB 消息/历史与 256 KiB checkpoint 限制，超限明确失败；分页、大输出分块、自定义 schema 及完整依赖闭包支持尚待后续阶段。源检查用于已知不支持用法的诊断，不能当作任意作者代码沙箱。

## 阶段验收

| 阶段 | 状态 |
| --- | --- |
| A0 功能基础 | 已提交并独立审计 |
| A0 性能/历史盘点 | 真实历史格式清单已保存；Python 性能及 RSS 门未关闭；盘点不等于历史导入通过 |
| A1 最小作者切片 | 实现中；真实 Hitch、外部作者体验、跨语言 provider 和非 winner 起点分别验收 |
| A2 历史读取/复用 | 待实现；原目录保持只读，缺件必须明确报告 |
| A3 统一宿主与内置接口 | 待实现 |
| A4 RHO/长期流程 | 待实现 |
| A5 训练适配 | 待实现；CPU 合同与真实权重/GPU 验证分别报告 |
| A6 FCS 迁移与发布 | 待实现；保留原 35 项差分科学语义门槛 |

旧实验读取兼容、FCS/RHO/GRPO 等价、真实训练和新 SDK 发布均未因 A0 功能提交而宣布通过。
