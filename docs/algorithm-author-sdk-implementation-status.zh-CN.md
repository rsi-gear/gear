# 作者 SDK 实施状态

实施依据：[v4 方案](algorithm-author-sdk-plan-v4.zh-CN.md)与[作者合同](algorithm-author-sdk-authoring-v4.zh-CN.md)。本文记录实际交付，设计文档中的 API 示例不自动成为已支持功能。

## 已提交

- `1025093`：A0 双语言作者运行层。支持惰性受管理调用、普通 async 顺序流程、自定义 workflow 与嵌套 parallel、冻结观察、不可变 checkpoint、同一 Campaign 的冷重放及源码身份校验。安装导出为 `rsi-gear/algorithm/author` 与 `gear_algorithm.author`。
- `97e938f`：冻结性能对照工具与第一份失败基线。正式复测报告单独保存，不覆盖失败记录。

主审验证：类型检查通过；8 文件、79 项相关回归通过，覆盖两种语言真实 controller SIGKILL 后原 key 恢复；Python SDK 40 项中 37 项通过、3 项可选 Optuna 测试跳过；仓库外 npm 安装与 Python wheel 导入通过。独立 reviewer 的功能结论及证据见 [A0 审计](experiments/author-a0-functional-review-20260926.zh-CN.md)。

## A1.1 双语言合同切片

新增显式 `gear.author.replay.v2`，定义 HarnessAgent、TaskSelection、RoleResult、ProposalBatch 和 Evaluation 的公共数据合同。`ctx.role` 与 `ctx.tasks.sample` 已生成对应的正式 operation 意图并验证返回结构；具体服务装配仍在下一切片。配置 schema 在第一次意图之前校验，TS 普通 `interface` 配置可直接使用。只读结果可以原样传入 workflow、checkpoint、operation 和 result；Python 提供 snake_case 属性访问。

两端目前共用 37 个 DTO 正反例（任务采样集成后增加一个限额负例），并通过真实 Python worker 的三次重放对照。Python 将 v2 的有限安全整数值统一为 int，允许 JSON `2.0` 用于 `range`，保留科学计算的小数值，拒绝 bool 及越界整数。数据结构校验不代表模型调用或评估产物已获得物理验证；这些检查属于通用宿主。

独立复审结论为本片段无剩余功能阻塞，见 [A1.1 审计](experiments/author-a1-contract-review-20260926.zh-CN.md)。主审另外验证了 4 文件 47 项受影响回归，以及仓库外 npm/Python wheel 安装和既有跨语言 worker 接线。类型 fixture 使用仓库相对导入，仅证明 API 类型可组合，不作为外部作者试用通过的证据。

## A1 历史候选输入切片

`src/history/nonwinner.ts` 可以从明确的旧实验目录读取 rejected / rejected-for-substrate round 中的 sealed 候选，并在新 CAS 中建立 Harness 引用、binding 与来源记录。它验证原始 JSON 字节、旧 schema、Git commit/tree/不可变 ref、实际单一父提交、修改范围与 manifest 文件闭包；读取旧数据不调用旧 runtime，也不继承预算、未决操作或 measurement。

当前仅支持新 profile 固定使用同一个物理 Git 仓库。新 CAS 必须与旧 state、原仓库及 Git common dir 分离；跨仓库搬运尚未实现。patchDigest 仅保留原记录，不声称重新构造验证。独立 history/state 回归 3 文件 44 项通过，见 [历史读取审计](experiments/author-a1-history-reader-review-20260926.zh-CN.md)。真实阿里云旧候选的导入探针已在 `720e91a` 通过：710 份构建文件摘要匹配，新 Harness/binding/来源记录可读，4 份相关原文件字节与 Git refs 未变，编译、Hitch、模型调用均为零。见 [真实导入记录](experiments/author-a1-history-import-20260926.json)。后续构建/执行、可运行 profile 和其他历史格式仍分别验收。

## A1 任务采样切片

`src/algorithm/providers/task-sampling.ts` 已实现授权 TaskView 的确定性无放回选样，保留原任务用途、exposure 和谱系，输出独立 cursor。它是纯本地操作，不计费、不启动预算时钟；丢回复后同一输入重算相同 CAS 结果。TS/Python SDK 和 capabilities validator 对这一约束一致。

独立 3 文件 47 项测试通过，包含真实 Python worker parity 与 SDK 前沿到 provider 的集成；Python A1 8 项及隔离类型检查通过。审计时另一个未冻结的 resolver 文件存在全仓类型错误，因此本次不宣称全仓检查通过。见 [任务采样审计](experiments/author-a1-task-sampling-review-20260926.zh-CN.md)。真实宿主装配和密钥/授权冻结仍待后续切片。

## A1 任务消费切片

`tasks.consume` 现在从冻结输入和授权 TaskView 纯重算，不再保存第二份 provider ledger。冷恢复及丢回复后使用原 key 重算相同有序 batch；每个候选从自己的 cursor 开始。入口保留输入 schema、operation 身份、签名授权、cursor 和 CAS 完整性检查，并禁止计量及启动预算时钟。

实施者相关 5 文件 12 项回归及类型检查通过；主审在最后的 schema 修复后独立验证 2 文件 8 项通过。独立审查无剩余功能阻塞，见 [任务消费审计](experiments/author-a1-task-consume-review-20260926.zh-CN.md)。真实宿主仍须负责装配数据用途和授权范围。

## A1 运行配置解析切片

`src/algorithm/author/run-resolver.ts` 解析 RunSpec、profile、角色及作者源文件，冻结 prompt/schema 字节，核验注入的只读 capability inspector 结果，生成 lock candidate。`check` 和 `explain` 使用同一解析函数。预算字段显式映射到 Campaign 的计量维度；内置角色 schema 与真实 provider 共用定义；纯操作禁止声明计量。提取出的 manifest 校验器同时供 kernel 使用，并进入 kernel 源码身份闭包。

独立 resolver/identity 回归 2 文件 7 项通过；实施者报告全仓类型检查及 resolver/kernel 25 项通过；主审另外验证原有角色/工作区编辑回归 2 文件 28 项通过。见 [解析器审计](experiments/author-a1-run-resolver-review-20260926.zh-CN.md)。本切片只是只读解析边界：实际 inspector、lock 发布及 run/resume 消费、作者输入到物理 operation 的转换和 CLI 接线仍待实现。

## A0 Python admission 生命周期优化

Python replay port 改为异步创建，首次 replay 使用刚完成环境准入的同一个 worker；之后每波仍新建进程。源码/环境/宿主身份检查保留，新增显式幂等关闭、未使用 worker 的闲置清理、启动及执行期间的取消，并更新现有调用方。

实施者构建及类型检查通过，相关 4 文件 38 项回归通过。独立审查隔离副本 2 文件 14 项通过，含真实 SIGKILL 与同版本冷恢复。第一次共享工作树测试为 13/14，失败发生于并行源码修改触发 host 闭包漂移；隔离冻结源码后通过，未取消身份检查。见 [生命周期审计](experiments/author-a0-python-admission-review-20260926.zh-CN.md)。已在隔离的 `770b3f9` 按原协议复测，Python 两种轨迹为 130.94/123.13 ms，仍未通过；不能据此宣称墙时改善。

## A1 可信评估汇总切片

`author.measurement` 从宿主验证的已提交 rollout 汇总结果，核对保存请求、物理凭据、任务与重复覆盖、绑定及冻结评分合同；仅完整有效的结果可参与比较。作者不能直接提交分数、receipt 或比较键。丢回复后可用原 key 纯重算；命名但未提交的 producer 不会被当作固定的缺失结果。

主审独立验证 2 文件 12 项通过，见 [评估汇总审计](experiments/author-a1-measurement-review-20260926.zh-CN.md)。本切片的 committed-operation resolver 是明确的宿主注入边界，真实历史读取、新 Hitch 请求持久化及 ctx.evaluate 接线仍分别实现和验收。

## A1 只读物理环境检查切片

新增独立于 EvolutionSpec 的管理员运行配置，读取真实 Git/Harness、标准 v1 编译数据集、Hitch capability 与冻结 meta 注册模块。聚合入口加载已检查的模块字节；配置和 manifest 有读取上界。标准数据集验证同时供现有搜索投影使用。

主审独立回归 4 文件 26 项通过，见 [物理检查审计](experiments/author-a1-physical-inspection-review-20260926.zh-CN.md)。这是部分只读探针，尚未生成完整可运行 lock；target 路由、真实服务装配与 CLI 仍待接线。Hitch 回归采用录制协议夹具，模型检查采用离线适配器，不作为真实服务运行证据。

## A1 编辑授权切片

候选工作区现在支持冻结的 allowedPaths，文件工具修改前和最终 Git diff 封存时都检查范围；物理编辑及 Skill overlay 身份包含授权摘要。主审独立回归 4 文件 36 项通过，见 [编辑范围审计](experiments/author-a1-edit-grants-review-20260926.zh-CN.md)。通用宿主传入 profile 授权仍在接线中。

## A1 v2 Campaign 接线切片

v2 adapter 和 TS/Python transport 现在冻结配置、能力、执行 profile 及可信 Agent policy，并校验初始/选中 HarnessAgent。内核提供真实终态 operation ID，v2 history 保存它；内部 tracked rollout 在业务失败和冷恢复后仍保留原 ID，作者无需推导。checkpoint/output 支持明确的 A1 typed 引用边。

隔离源码验收：实施者 106 项 TS 与 25 项 Python author 测试通过；主审独立 v2/内核身份/预算回归合计 5 文件 27 项通过。见 [v2 运行接线审计](experiments/author-a1-v2-runtime-review-20260926.zh-CN.md)。这些是受控 provider 与真实语言 worker 的验证，尚不代表外部项目或真实 Hitch 搜索可用。

## A1 已提交 rollout 历史解析切片

默认本地 CampaignStore 的只读解析器现在能验证同一 HEAD 的完整历史链，找到已从当前 operations 清除的终态 rollout，配对物理 journal，并拒绝只完成在物理侧而尚未提交到内核的结果。measurement 绑定解析器实现身份，作者评估使用独立 author-candidate phase。

主审独立回归 2 文件 15 项通过，含真实内核正常完成与取消时发现完成两条路径，见 [历史解析审计](experiments/author-a1-committed-rollout-review-20260926.zh-CN.md)。实际 Hitch reader 接线及增量 JournalCampaignStore 后端仍分别验收。

## 当前限制

A0 是运行基础。`propose/evaluate/select`、通用运行 profile、五文件作者项目及新的 CLI 仍待后续 A1 切片；现有 A0 role/edit/rollout/measure 便利方法用于探针，v2 已拒绝这些假 operation。用户不能仅复制 v4 的搜索示例便运行真实实验。

性能按冻结标准报告：TS 的两个代表性轨迹通过每前沿额外 100 ms 门槛，Python 最新在 `770b3f9` 为 130.94/123.13 ms，仍未通过；TS 为 86.30/75.98 ms，两语言冷恢复通过。操作图 F/O/J 和原 key 一致，恢复没有重复物理执行。进程树峰值内存目前只有抽样证据，上界未验证。见 [最新正式复测](experiments/author-a0-benchmark-770b3f9-20260926.json)；[此前失败记录](experiments/author-a0-benchmark-97e938f-20260926.json)保留。未选择产品默认前沿上限，长流程门尚未验证。

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
