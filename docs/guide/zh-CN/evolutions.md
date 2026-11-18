# 运行与恢复

所有命令可使用 `--project DIRECTORY` 和 `--json`。一次独立 evaluate 也有自己的 run 和预算账本。

```sh
gear evaluate --split seed --limit 1
gear refine --rounds 1
gear report RUN_ID
gear resume RUN_ID
gear cancel RUN_ID
gear export RUN_ID
```

`resume` 恢复原 run，先检查已提交操作的结果，不重新抽样已保存决策。不要把未知提交当作未提交。
`cancel` 先持久化请求并向 provider 传播；观察报告确认结果。服务停止保留待恢复状态，与用户取消不同。
`export` 只接受已完成 run，核对保留候选的封存身份后输出 target、manifest 和 report。重复导出返回同一位置，已存在但被修改的导出会被拒绝。

新的 `refine` 创建新的 run，并继承当前已晋级候选；`resume` 不用于增加轮数或替换算法。新 run 与之前的评测身份和用量来源保持可追踪。

## 重试已结算的只读 Meta 失败

普通 `project.resume(run_id)` 接续未结束的运行。v2 算法也可以在只读 Meta 失败后、算法状态尚未推进时显式重试该调用，包括以失败 outcome 结束的运行。运行层确认旧执行停止、失败回执一致且所有用量已知，再复用原目标输出、学习库和状态。

先执行 `gear report RUN_ID --json` 检查结果。将下例的 `run_id` 和 `failed_operation_id` 替换为实际值；失败操作的 `request.operationId` 位于 `.gear/runs/RUN_ID/journal.json` 的 `operations` 中，可只读查看。它不是 `operators.calls` 的调用 ID。下面的额度只是示例，须替换为该运行已批准的新累计上限：

```python
from gear import Project

project = Project.open(".")
recovered = project.resume(
    run_id,
    retry_operation=failed_operation_id,
    generation={
        "max_tokens": 1_000_000,
        "per_operation": {"max_tokens": 300_000},
    },
)
print(recovered.id, recovered.report.summary["meta_recoveries"])
```

`max_tokens` 是包含历史消耗的 run 总上限，不是额外赠送的额度；例子将总上限设为 1,000,000、单次上限设为 300,000。省略的维度保留原限制，限制只能显式提高。若原额度仍够用，可省略 `generation`。改动项目配置文件不会更新旧 run 的预算。

CLI 使用相同参数；`generation.json` 的内容就是上述 `generation` 对象：

```sh
gear resume RUN_ID --retry-operation FAILED_OPERATION_ID --generation-config generation.json
```

恢复保留原 run ID、冻结配置、全部旧操作和用量。原 journal 字节保存在恢复检查点，新尝试使用新的 operation ID；`meta_recoveries` 记录关联，`recovered_operation_ids` 只列出已有成功后继的原失败操作。同一失败 ID 与相同参数重复提交不会再创建一次尝试；新尝试再次失败时，需明确指定新的失败 ID。

该入口适用于 v2 的只读 `Meta` 调用。候选生成、未知用量、计量违约、用户已取消、算法状态已推进或不匹配的执行条件均不适用。未知结果先恢复并查询原操作；不能把它当成一次已经结算的失败重发。目标评测的修补次数、轮数与目标预算仍按原配置执行。

## Hitch 重启后的绑定变化

若仅宿主环境绑定改变，可以在上述恢复请求中增加 `environment_binding=original_public_binding`；CLI 为 `--environment-binding-config FILE`。传入的是原公开绑定，不是凭据。运行时必须验证模型、代码、资源、任务产物、能力、凭据变量选择与 Meta 身份都保持一致，才记录新旧实际执行身份。历史结果不改写，后续样本使用新身份。

这会继续 Gear 算法并重试失败反思，不会恢复 Codex 的内部会话，也不允许任意更换模型或代码继续旧实验。原绑定的字段和完整约束见[算子作者指南](../../algorithm-operators.zh-CN.md#调用与恢复)。

自然语言入口使用相同操作。项目 socket 的 `run.refine` / `run.evaluate` 支持稳定请求 ID；丢失响应后重用 ID，相同参数返回同一个 run。不同参数会报 admission 冲突。详见[控制面](../../harness-agnostic-refine-skill.md)。
