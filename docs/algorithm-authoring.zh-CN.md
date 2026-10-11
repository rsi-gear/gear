# 编写算法：显式状态与执行服务

普通作者写一个 Python 或 TypeScript `step`。它读取持久状态与上批结果，返回下一批请求或最终结果。任务选择、接受条件、繁殖档案和终止条件都属于算法。新增算法不修改 host 或 kernel。

默认入口是 Python `gear_algorithm` / `gear_algorithm.author`、TypeScript `rsi-gear/algorithm` / `rsi-gear/algorithm/author`。先按[CLI 快速使用](algorithm-author-cli.zh-CN.md)生成并运行 best-of-N，再参考[三种控制结构](../examples/algorithms/step-search/README.md)。示例展示 GEPA/RHO/DGM 风格的结构，不声称论文复现。

```python
from gear_algorithm import algorithm

@algorithm(id="baseline")
def search(ctx):
    if ctx.state is None:
        return ctx.run({"phase": "evaluate"}, tasks=ctx.services.sample(ctx.task_source, 1))
    if ctx.state["phase"] == "evaluate":
        tasks = ctx.results["tasks"]
        if not tasks.ok:
            return ctx.finish(outputs={"failure": tasks.error})
        return ctx.run({"phase": "finish"}, measured=ctx.services.evaluate(ctx.initial_candidate, tasks.value))
    measured = ctx.results["measured"]
    if not measured.ok or not measured.value["comparable"]:
        return ctx.finish(outputs={"status": "no_valid_evaluation"})
    return ctx.finish(selected=measured.value["subject"], outputs={"evaluation": measured.value})
```

`ctx.run(state, **requests)` 是持久边界。框架先把新状态与全部操作意图原子提交，再执行外部效果。服务展开中的编辑、绑定派生、任务消费、rollout 和测量也经过同一 Campaign 日志。重启从最后一次提交继续；未提交 step 内的纯计算可能重做。模块全局变量、对象缓存、随机库内部状态、Python 堆和协程不属于持久状态。需要恢复的随机种子、索引、候选和统计量由作者显式保存为 JSON。

可以正常使用科学计算库。作者的 step 应把模型、工作区、评估等需要恢复或计量的效果交给 services；在 step 中自行调用外部服务无法获得这些保证。框架没有整段函数重放、AST 库禁令或第二套 workflow 调度器。

## 领域对象

| 对象 | 含义 |
| --- | --- |
| Candidate | 不可变被测版本的绑定和执行配置身份。分数不写在 Candidate 上。 |
| Task / TaskSelection | 真实题面与用途、exposure、谱系；或已签名的任务选择。 |
| Evaluation | 针对 Candidate 和 TaskSelection 的评价。完整有效时才有 metrics、measurementRef 和 comparisonKey。 |
| Evidence | 内容寻址证据引用；真实分数由可信测量从已提交物理执行证据计算。 |
| Archive | 算法选择的可繁殖候选池。它可以保留非赢家；Campaign 仍是完整事实历史。 |
| ExecutionServices | 宿主授予的任务、编辑、模型和评估能力。作者不填写 operation ID、provider manifest 或预算回执。 |

每个服务结果是 `Result`。Python 使用 `result.ok / result.value / result.error`；TypeScript 是判别联合。`ok:false` 保留基础设施错误、无结果或取消等情况；`ok:true` 的 Evaluation 仍可能 `comparable:false`，此时没有可用分数。有效零分是 `comparable:true`、metric 为 0。框架不自动把失败改成零分，也不替作者决定跳过、接受或停止。

## 服务

| Python | TypeScript | 返回值 |
| --- | --- | --- |
| `sample(source, count, seed)` | 同名 | TaskSelection，无放回确定性抽样 |
| `tasks(ctx.task_source)` 或 `tasks(selection)` | `tasks(ctx.taskSource)` | Task[]，含真实 prompt |
| `select(task_ids, purpose="development")` | `select(taskIds, purpose?)` | 从宿主授权任务中按作者策略选择 |
| `propose(parent, role="optimizer", count=1, feedback=None)` | `propose(parent, {role, count?, feedback?})` | Proposals，分别保留成功候选与编辑/校验失败 |
| `evaluate(candidate, tasks)` | 同名 | Evaluation，使用宿主冻结的评价合同 |
| `role(name, input, candidate=None)` | `role(name, input, candidate?)` | 已授权模型角色的结果 |
| `call(name, input, candidate=None)` | `call<T>(name, input, candidate?)` | 额外宿主授予能力，经同一日志与预算 |

一次 `run` 中的请求可以并行；执行中操作总数由 Campaign 的单一 `concurrency` 设置控制，包括恢复后和辅助操作。宿主另行施加实际资源容量。预算在准入时预留，按可信回执结算；不能硬限制的 token 计量使用 stop 能力。

TypeScript 定义轻量 State 联合和 Config 即可；[实际 `.ts` 示例](../examples/algorithms/step-search/best_of_n.ts)不需要 `as any` 或 `as unknown`。`ctx.results.get<T>(name)` 中的 T 由作者声明，当前不自动从跨 step 的请求推导。框架在进程协议和持久数据入口校验结构；内部状态没有层层冻结、深拷贝包装。

Python 的 `Archive` 是可序列化的 list；TypeScript 的 `Archive` 通过 `.candidates` 保存普通数组。保存较大的科学产物时使用宿主提供的 artifact 能力和引用，不把全部事实历史再复制进 state。

## 宿主与恢复

默认教学宿主 `host:"recorded"` 不运行模型、编译器或 Hitch。真实执行使用共用的[物理宿主装配](../examples/algorithms/step-search/README.md#物理执行)，复用 Git/CAS、任务授权、workspace editor、DSH role、Hitch 和可信 measurement。宿主配置能力与目的地；切换算法只换作者模块和科学参数。

`run` 持续观察已提交任务，直到完成或收到 SIGINT/SIGTERM。停止本地观察不等于撤销外部任务；下次 `resume` 使用同一配置与状态目录。提交后丢回复的操作先 inspect/reconcile；无法确定结果时保持 unknown，不能改键直接重试。任意 DSH 会话或 Git finalization 中断并不保证透明续跑，当前物理 provider 可能需要外部对账。更改算法代码、依赖或执行身份需要新 Campaign，本文不承诺跨版本恢复。

旧 FCS 和科学 recipe 仍保留必要的低层 initialize/reduce 及差分测试作为内部迁移支持。新项目使用本页接口；此前 v4 replay 设计文档仅作历史记录。
