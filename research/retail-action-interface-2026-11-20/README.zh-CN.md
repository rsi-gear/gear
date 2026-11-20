# 动作输出接口检查：冻结权重，无 GPU 训练

**嵌套动作 schema 已通过真实模型与实际 CPU 工具检查；这不是任务成功率或 failure 数据效果证据。** 检查明确要求模型返回一次 `get_user_details` 动作，再由调用方执行，因此不能用其成功评价自主规划能力。

| 尝试 | 冻结源码 | 实际结果 | 用量 |
| --- | --- | --- | --- |
| v1 | `9c81f15d6` | 服务端拒绝根节点 `anyOf`，HTTP 400／`invalid_json_schema`；只读检查原 turn 确认为 `failed`，未执行工具 | 未提供原生 usage，保持未知 |
| v2 | `c032ab44a` | `gpt-6-luna low` 返回 `{"action": ...}`；schema 验证通过，实际 CPU 查询成功，数据库前后相同 | 1 个逻辑 turn，27,587 native tokens |

两次均在提交前封存输入、代码身份、schema 和一次调用上限。第二次对应新的源码与独立目录，没有重用或替换第一次请求。合计两次逻辑提交、一次完成、一次失败；全部尝试的总 token 用量仍未知。SDK 回执的 `total` 包含内部累计用量，不能只取 `last` 或将 cached input 再加一次。没有权重更新、GPU 作业、任务评分或数据生成对照。

实际修复仅在调用方：文本桥接明确允许返回供外部执行的动作，SDK 原生工具仍关闭；schema 在对象的 `action` 属性内区分工具和非空消息／结束回复，retail 对话和 Agent-R 执行处直接取值。原始响应保留整个对象，实际工具轨迹保持原格式。`gear.curriculum` 没有执行或转换层。

嵌套格式修复后的 CPU／CLI／worker 回归共 114 项通过，1 项可选真实 MiniLM 检查跳过。模型均为明确替身，与上述两次真实接口提交分开核算。

[evidence.json](evidence.json) 与 [manifest.json](manifest.json) 保留两个请求、终态、完整原生 usage 和实际工具结果；SDK thread/turn ID 脱敏，原生 receipt 摘要在导出前校验后移除。[probe.py](probe.py) 保存成功检查时的原始脚本字节，便于核对脚本摘要；运行它会提交最多一次真实模型请求。

[verify.py](verify.py) 只执行本地复核：验证请求／协议／源码绑定，重新校验真实响应的嵌套 schema，在固定 Tau2 上重放只读查询。它不导入 SDK、不提交模型请求，[本次复核通过](verification.json)，合成数据库来自已固定摘要的 [V4 归档](../sentinel-retail-2026-11-20-v4/README.zh-CN.md)：

```sh
/path/to/sentinel-env/bin/python research/retail-action-interface-2026-11-20/verify.py \
  --repository /path/to/gear-at-c032ab44a --tau2-source /path/to/pinned-tau2
```

完整工具域 fixed/random/failure 效果对照仍单独验收，不能以接口检查替代。
