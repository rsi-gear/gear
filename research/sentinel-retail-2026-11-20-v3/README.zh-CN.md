# Retail 三组对照入口与真实运行中止记录

**对照入口已实现；本次真实效果对照未完成。** 原始请求遭遇服务端 429，唯一一次恢复中的请求达到 240 秒超时，SDK 随后报告 `interrupted`。两次尝试均未完成第一个训练任务，没有可用于诊断的完整成功／失败观测，也没有数据策略的效果结果。这不是 failure 数据无效的证据。

实现冻结在 `6d3959e4f`，运行目录使用独立 worktree。没有 GPU 训练或权重更新。源码入口为 [sentinel_experiment.py](../../examples/curriculum-harness/sentinel_experiment.py)，规则见 [SENTINEL 调用方](../../examples/curriculum-harness/SENTINEL.zh-CN.md)。52 项定向检查通过，其中模型均为明确替身；正式三组集成覆盖实际 CLI／worker、数据隔离、候选修订、最终测试封存、恢复及缺额后的不可比较状态，不能代替真实效果证据。

## 预先固定的实验

使用人工编写的合成客户、商品和订单，不读取上游 benchmark 数据库或任务。2 个训练任务涉及同一待发货订单的地址／付款和全部商品选项修改；1 个选型任务涉及地址与付款；2 个最终测试任务将订单修改分别与另一订单的退货或取消组合。训练、选型、测试的 family、任务 ID、精确内容隔离；全部 5 条参考轨迹均实际执行并通过 native DB 校准，空操作和删除写操作的负例被拒绝。

`evidence.json` 保存完整原始配置、参考轨迹和协议。主要设置：

| 项目 | 预先声明的设置 |
| --- | --- |
| 组别 | fixed／random／failure；同一正常工作的初始 retail harness，不设置提前结束控制 |
| 轮数与 seed | 1 轮，配对调度 seed `23`；不控制模型内部采样，不主张统计显著性 |
| 模型 | solver、用户模拟及生成均为 `gpt-6-luna`，`low`；搜索 Meta 配置为 `gpt-6-astra`，实际尚未调用 |
| 练习池 | fixed 用 2 条原始任务；其余两组用 1 条原始任务加 1 条生成任务 |
| 生成 | 每组恰好 1 次预定尝试；共享执行、校准与审查，无成功条件下的补抽 |
| 调用配额 | 原始每任务 56、每次生成 64、每轮正式搜索 280 个逻辑 SDK turn；最多 24 步 |
| 候选约束 | 最多 1,800 字符，写作目标 1,400，最多 2 次修订 |
| 最终测试 | 必须先封存全部组选型，再执行相同的固定测试集；本次没有打开模型测试 |

## 实际执行与恢复

| 尝试 | 已保存完成回执 | 未完成请求的已核实终态 | 后续动作 |
| --- | ---: | --- | --- |
| 原始运行 | 5 | `failed`；`exceeded retry limit`，HTTP 429 | 只读核实原始 turn；允许唯一一次隔离恢复 |
| 恢复 1 | 2 | 240 秒本地超时后为 `interrupted` | 只读核实；不再追加尝试 |

恢复保持任务、模型、提示、生成和搜索配额不变，只把每任务配额从 56 降到 50，将原始运行已提交的 6 次调用计入原预算。原始轨迹没有重标为训练失败，也没有被用作生成输入。原始及恢复目录均保留；不存在运行中的实验进程或等待中的模型请求。

合计 **9 次已提交 turn，7 份完成回执，完成回执记录 127,163 tokens**。另外两次请求缺少原生用量，全尝试 token 总数保持未知。SDK 内部 HTTP 重试次数和美元费用未计量。完整任务评分、生成尝试、正式搜索和最终测试次数均为 0；不报告通过率或组间提升。

## 离线复核

[verification.json](verification.json) 记录实际重新执行 5 条参考及负例、2 段未完成轨迹，并核对全部 7 份原生完成回执和下一条已提交请求。没有导入 SDK，没有新增模型请求。[negative-checks.json](negative-checks.json) 记录四项反证检查：修改原生响应、修改待定请求、编造未知用量、给未完成轨迹补造失败结果，均被拒绝。

[manifest.json](manifest.json) 的导出 SHA-256 为 `1848e4b65117f5e7b758eeb50efa29f74e4b5e8c97b53f41c5546f4628c73feb`。SDK thread／turn ID 已脱敏，保留模型输入、响应、用量、工具执行和终态证据。复核只依赖导出文件、冻结源码和固定 Tau2 环境，不需要原始运行目录或登录：

```sh
/path/to/sentinel-env/bin/python research/sentinel-retail-2026-11-20-v3/verify.py \
  --repository /path/to/gear-at-6d3959e4f \
  --tau2-source /path/to/pinned-tau2
```

[prepare.py](prepare.py) 可零模型调用重新构造任务和原始配置；已核实重新生成配置的摘要仍为 `sha256:d10d4e42153ce48f5737f9456a1405d58e588a0fe770f51ada7a99b0ae1035e1`：

```sh
/path/to/sentinel-env/bin/python research/sentinel-retail-2026-11-20-v3/prepare.py \
  --repository /path/to/gear-at-6d3959e4f \
  --tau2-source /path/to/pinned-tau2 --output /tmp/retail-study-input
```

本次只能验证入口和中断前执行证据。retail 的完整真实三组对照、mastery 测量及稳定收益仍待验收；已有 IFEval 对照的负结果另见 [V5 报告](../curriculum-harness-2026-11-20-v5/README.zh-CN.md)。
