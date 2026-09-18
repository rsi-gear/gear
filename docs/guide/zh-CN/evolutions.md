# 运行与管理进化

创建新实验、检查状态，再明确选择继续、修复或发布。以下命令是 DSH 的 Skill 调用。

## 开始与检查

```text
/refine --rounds 1 --name marketing --focus workflow,tool
/refine status
/refine status EVOLUTION_ID
/refine status EVOLUTION_ID ROUND_ID
```

用返回值替换 ID。普通 `/refine` 总是创建新 evolution。`--budget MILLISECONDS` 设置每个 trial 的 timeout，不是总费用或 Meta 生成期限。`--from initial`、`--from published` 或 exact commit 用于选择起点。

观察生成状态、评测覆盖和终态决定。已完成轮次可以保留旧 champion；控制面操作失败本身不能说明 candidate 的质量。

## 继续已封存实验

```text
/refine continue EVOLUTION_ID --rounds 2 --focus workflow
```

continue 仅允许改变 `--rounds` 和 `--focus`。数据集、模型、预算、runtime 和组件身份沿用原 spec。默认路径从当前已接受 champion 生成候选；未晋升版本不会仅因留有研究记录就成为下一轮代码父代。

## 修复评测槽位

```text
/refine rerun EVOLUTION_ID ROUND_ID --eval EVAL_ID --invalid
/refine rerun EVOLUTION_ID ROUND_ID --eval EVAL_ID --task TASK_ID
```

先由 status 确认哪些证据可修复。多次 attempt 时，task 修复覆盖该任务所有无效或缺失 attempt，保留有效槽位。direct 需要 Hitch 0.2.5+；daemon 需要 0.2.6+ 和对应 state root 的运行中 daemon。凭据 wrapper 可能有更严格限制。

修复已有评测时不要重启原始 launch 脚本，先确认现有 ID。分阶段研究路径还提供 archive evidence completion，见[案例二](example-algorithm.md)。

## 发布与回滚

```text
/refine publish EVOLUTION_ID
/refine rollback EVOLUTION_ID EXACT_ACCEPTED_COMMIT
```

自动晋升按封存策略更新 evolution champion。publish 修改工作区默认版本；rollback 为该 evolution 选择曾接受的版本。两者均是明确的操作指令，解释人工晋升历史时也应保留区别。

## Standalone 客户端

外部 Refine Skill 使用 `control.start`、`control.status`、`control.continue`、`control.rerun`、`control.publish` 和 `control.rollback`。字段与请求结构由[协议参考](../../../skills/refine/references/protocol.md)定义，优先使用 Skill，不凭 DSH 命令文字猜测 JSON。
