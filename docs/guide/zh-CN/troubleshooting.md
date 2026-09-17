# 排查运行问题

启动替代工作前，先检查现有 evolution 与 evaluation ID，保留能够解释故障的证据。

## 现象与处理

| 现象 | 检查内容 | 下一步 |
| --- | --- | --- |
| DSH 没有 `/refine` | 插件启用状态、Skill catalog、模型配置 | 按安装指南配置，加载随包 Skill。 |
| socket 连接失败 | ready 输出与 `GEAR_REFINE_SOCKET` | 使用实际返回路径，保持 server 运行。 |
| identity mismatch | runtime、完整 Skill bundle、模型与采样 | 恢复封存身份，或新建 evolution。 |
| `initialChampion is required` | Target bootstrap 输出 | 提供真实 ref 和 manifest，不填写假 digest。 |
| manifest mismatch | 导入源码、substrate 与生成 manifest | 为新源码重新 bootstrap，不改旧证据。 |
| runtime 为 `not_checked` | compiler、report protocol、runtimeRoot | 配置真实 checker，逐项检查覆盖。 |
| 暂无 candidate assignment | baseline 进度与生成状态 | baseline 可能仍在运行，先查看 status。 |
| Meta 诊断超时 | 未诊断失败任务与生成预算 | 使用允许的恢复路径，新 attempt 不清零轮次期限。 |
| Hitch 评测失败 | doctor、原生 result、verifier、无效槽位 | 使用已有 evolution/eval ID 修复支持的槽位。 |
| 候选 decline 或未晋升 | 诊断与比较结果 | 可能是正常结果，查看理由。 |

## 常用检查

```bash
hitch eval doctor --json
gear-refine request control.status '{}'
node examples/automationbench-marketing/inspect.mjs
```

request 命令需要运行中的 Standalone server/socket；DSH 使用 `/refine status`。过期的 `running` 投影不足以判断应重启工作，还要核对真实结果与执行生命周期。

## 证据与恢复边界

有效零分表示任务未通过断言。verifier 缺失、容器启动失败或轨迹无效需要先诊断，不能静默计为模型失败，也不应直接重跑整个数据集。

lease 失效后停止使用；可恢复 API 动作由 Skill 按返回顺序处理。要求 operator action 时，修复具体原因，不手工修改 Gear 状态 JSON。[详细运维指南](../../plugin-installation-and-usage.md)覆盖平台与旧模式问题。
