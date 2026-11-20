# 显式结束回复与独立生成模型检查

**显式结束回复通过真实 API 验证；单次生成在 429 后停止，未产出有效练习。没有效果对照或 GPU 训练。** 冻结源码为 `f5947efb5`，这次检查独立于已中止的工具 V5，不恢复、替换或重新评分 V5。

提交前封存的协议只允许一次结束回复检查及一次生成尝试，上限为 57 个逻辑 turn，失败或拒绝后不另开尝试。实际请求和协议见 [evidence.json](evidence.json)，文件摘要见 [manifest.json](manifest.json)。[probe.py](probe.py) 保存原始脚本字节及其摘要；再次运行它会发起真实请求，不是离线验证入口。

| 部分 | 实际行为 | 结果与已知用量 |
| --- | --- | --- |
| 显式结束回复 | `gpt-6-luna low` 读取 V5 原始未完成训练对话，工具列表为空，按新 schema 返回非空结束回复 | 1 次完成，15,513 tokens；明确说明修改尚未完成，原任务分数保持未知 |
| 独立生成模型 | `gpt-6-astra low` 根据 V5 的完整失败训练记录诊断、规划目标并探索；实际 CPU 执行身份查询和用户资料查询 | 5 次完成，66,919 tokens；第 6 次生成请求 `explore/2` 返回终态 429，未产生完整参考、候选或准入练习 |

合计 7 次逻辑提交、6 次完成、1 次基础设施失败，已知原生用量 82,432 tokens。失败请求没有 usage，因此全尝试 token 总量、HTTP 重试数和美元成本均未知。CPU 执行的两步都是只读操作；没有权重更新、最终测试或比较结果。

已只读检查原生 turn，确认错误为 `exceeded retry limit, last status: 429 Too Many Requests`，没有重新提交。随后账户读数为 `ordinary_usage_allowed=true`、周窗口使用 85%；该快照不能证明限额耗尽、解释 429 原因或证明服务恢复。保留失败请求，不将 API 失败计为任务失败。

当前实现的 `final_reply_on_limit` 默认关闭；启用时在动作预算结束后额外允许一次真实结束回复，禁止新工具和提问，费用单独计入预算。只有实际收到、验证并执行结束动作后，完整轨迹才交给原有评分；调用未知或失败仍保持未知。`generator_model` 可单独指定生成侧模型，默认沿用 solver；random 与 failure 使用同一配置。35 项相应 CPU／CLI／worker 检查通过，模型替身检查与这里的真实调用分开计量。

[verify.py](verify.py) 绑定原始 V5 归档、冻结调用方、请求和响应，重建结束回复输入，并在新内存数据库中重放全部生成前缀；到原失败请求时验证输入并停止。它不导入 SDK或发起请求，不能补全失败后的输出。[本次离线核验](verification.json)通过，修改失败请求、工具结果或补造原任务分数的三项检查均被拒绝。

```sh
/path/to/sentinel-env/bin/python research/retail-final-reply-teacher-2026-11-20/verify.py \
  --repository /path/to/gear-at-f5947efb5 \
  --tau2-source /path/to/pinned-tau2 --negative-checks
```

完整工具域 fixed/random/failure 对照仍未完成。这次检查仅证明结束回复接口兼容，不能证明独立生成模型能产出有效数据，也不能证明 failure 数据带来收益。
