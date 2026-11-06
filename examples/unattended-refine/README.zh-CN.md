# 监督已登记的 refinement 运行

[English](README.md) | [简体中文](README.zh-CN.md)

在 Gear 源码目录中安装同一版本的 Gear Python 包与 CLI，然后指定现有项目和 run ID：

```sh
python examples/unattended-refine/supervisor.py \
  --project /absolute/project \
  --run-id run_existing \
  --output /absolute/new-private-supervision-directory
```

示例通过公开的 `Project.report()`、`Project.resume()` 操作同一个已登记的运行，
沿用冻结配置与 Gear 的提交状态核对。最多尝试 12 次，可恢复错误之间等待 30 秒，
普通可用空间低于 8 GiB 时停止。只有明确列入 `RECOVERABLE` 的错误码允许继续；
未知或格式损坏的失败转为 `needs_attention`。Python SDK 本身不自动重试。
已完成或已取消的运行结束监督。

输出目录必须是新目录。`status.json` 保存进度，成功恢复的报告保存为 JSON，
`execution-N.stderr.log` 原样保留失败调用的诊断字节，包括终端 CLI 错误之前的警告。
`ProjectError.from_stderr()` 只接纳最后一条非空行上完整、扁平的 Gear 错误对象，
要求 `code`、`message` 与已知可选字段；错误码保留非空字符串的原始拼写。
嵌套对象、日志前缀、重复键和错误之后的日志
都不能触发恢复。原始字节单独保存在 `ProjectError.stderr`，不加入普通异常消息；
这些私有日志可能包含敏感 provider 诊断。

这是前台运行示例。明确开始新一轮监督时选择新的输出目录；重新运行示例不会扩大
Gear 已冻结的评测修复规则或 trial 预算。
