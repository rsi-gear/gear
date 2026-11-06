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

自然语言入口使用相同操作。项目 socket 的 `run.refine` / `run.evaluate` 支持稳定请求 ID；丢失响应后重用 ID，相同参数返回同一个 run。不同参数会报 admission 冲突。详见[控制面](../../harness-agnostic-refine-skill.md)。
