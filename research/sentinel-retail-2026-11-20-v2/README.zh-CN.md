# SENTINEL retail：实际失败采集、记忆与混合池探针

冻结源码 `9d7a3e4c89f8aadd7ebe099255ea3c922bea1632`，模型 `gpt-6-astra`，effort `low`。**实际 solver 失败已进入生成器，但生成的候选被语义检查拒绝，最终没有新任务进入混合池。** 本次验证了实际采集、生成、拒绝、记忆传递与缺额处理，不证明 harness 收益。没有 GPU 训练或模型权重更新。

固定输入采用[首版探针](../sentinel-retail-2026-11-20/README.zh-CN.md)生成的取消订单任务和虚构训练数据库。该旧任务的生成曾使用失败夹具；本次作为生成依据的 solver 轨迹与 verdict 则来自实际模型、工具执行和评分。未使用 Tau2 benchmark 任务或客户数据。

## 实际结果

| 阶段 | 结果 |
| --- | --- |
| 正常 retail harness | 1 个样本完成：认证、查询、确认后取消 `#G100` 并退款，保留 `#G101`；native DB=1，语义 policy 检查通过 |
| 提前结束的诊断对照 | 1 个样本按预先声明的停止规则直接结束，没有工具执行；native DB=0，产生完整失败观测 |
| 失败驱动生成 | 从该实际失败诊断并生成 1 个候选；参考执行成功，native 校准为 reference=1、no_actions=0、missing_writes=0 |
| 候选验证 | valid、faithful、policy_compliant 为 true；hides_solution 为 false，候选被拒绝 |
| 跨轮记忆 | 原案例和失败模式被保留；相同来源不重复诊断，不增加复现次数，不推断 mastery；0 次新模型调用 |
| 混合池 | 请求 fixed=1、generated=1；实际可用 1 和 0，返回 `insufficient`，选择为空；未用固定任务补齐缺额 |
| 导出后独立重放 | 实际工具、native 校验、评分、生成决策、记忆和池选择重新执行且一致；新增模型提交 0 |

候选明确要求完成取消，不能只告诉用户操作步骤。语义审查认为其私有用户指令暴露了验证细节与确认顺序，因此 `target_fidelity` 检查失败。这里报告的是独立模型调用的判断，不把它当作正确性 oracle；未修改标签、放宽策略或重抽候选来绕过拒绝。

提前结束规则是有意设置的诊断对照，所以两个 solver 样本的差异不能解释为自然失败率或改进效果。当前真实探针覆盖的是拒绝后处理分支；固定／生成各一条的成功混合、跨轮新失败累积等路径由明确模型替身的实际工具集成测试覆盖。retail 的正式 `Project.refine` 交接、独立效果对照与 mastery 测量仍待实现。

## 用量与服务故障

| 阶段 | 已完成模型调用 | 有原生 usage 的 tokens |
| --- | ---: | ---: |
| 正常 harness 采集 | 8 | 119,916 |
| 提前结束对照采集 | 2 | 29,430 |
| 生成恢复尝试 | 13 | 182,769 |
| 记忆传递与混合池 | 0 | 0 |
| 已完成部分合计 | **23** | **332,115** |

另有 **1 次生成请求因服务端模型容量不足而失败**，没有模型答案或候选。通过只读读取原 turn 确认 `failed` 后，单独封存并执行了一次恢复尝试，沿用同一模型和失败材料。原生成预算 30 次扣除已提交的 1 次，恢复配额为 29 次；没有额外候选重抽。这个基础设施恢复是明确记录的协议调整，首个失败尝试没有被删除。

总计提交 24 个逻辑 SDK turn。容量失败没有可用原生 token usage，因此 **332,115 只代表已完成调用，全尝试 token 总数未知**；未报告美元成本或底层 HTTP 请求数量。配额不是 HTTP、token 或美元硬上限。

## 证据与复核

- [evidence.json](evidence.json)：原协议、单独的恢复计划、容量失败终态、各阶段输入／完整模型回执／工具记录／评分／结果，以及拒绝候选的排除记录。native thread/turn ID 已移除。
- [manifest.json](manifest.json)：冻结源码、导出字节摘要、各阶段已完成调用和用量。
- [runtime.json](runtime.json)：实际 Python 和依赖版本。
- [verification.json](verification.json)、[verify.py](verify.py)：重新执行实际工具与原生评分，逐项核对模型输入和产物；只重放已保存响应，没有 SDK 客户端。
- [第三方材料说明](NOTICE.md)及原始 [MIT license](TAU2-LICENSE.txt)。

按照[调用方指南](../../examples/curriculum-harness/SENTINEL.zh-CN.md)安装固定 Tau2 依赖与 checkout 后运行：

```sh
/tmp/gear-sentinel-env/bin/python research/sentinel-retail-2026-11-20-v2/verify.py \
  --tau2-source /tmp/gear-sentinel-tau2
```

复核会检查实际源码及相关依赖身份；后续实现变化须使用上述冻结版本，不能把旧回执自动升级。独立临时目录仅重定位产物中的本地 workspace 路径，模型输入保持原样。摘要和重放证明内部一致性，不是模型服务的第三方签名。

该实现批次通过 37 项定向检查、58 项 curriculum 回归、14 项 CI 规则检查与依赖边界检查；未安装可选依赖的环境仅通过 4 项纯测试，27 项 native 集成明确跳过。完整设计的范围见[验收台账](../../docs/curriculum-implementation-status.zh-CN.md)。
