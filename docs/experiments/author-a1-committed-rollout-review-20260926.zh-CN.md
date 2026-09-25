# A1 已提交 rollout 只读解析审计

结论：本切片可提交，真实 Hitch journal 读取仍需由物理端口接入。

createLocalCommittedRolloutResolver 对默认 CampaignStore 的 HEAD 只取一次，验证其完整 SHA-256 历史链，从历史状态取得已经提交的 rollout。它不依赖当前 state.operations，因此 decision.reduce 清空当前操作后仍可读取已完成 producer；仅有物理完成而内核未提交的操作不能成为评估证据。解析器配对真实物理 reader 的 envelope/completion/outcome，并将自身源码、冻结上限、journal 路径和物理 manifest 纳入身份；measurement 构造时核对该身份。

主审补充并确认：读取采用 FD 分块硬上限和严格 UTF-8，避免 fstat 后增长造成无界分配；除正常 operation.completed 外，接受真实内核取消时发现操作已完成的 operation.cancel-response。操作 ID 复核内核派生规则。新增 author-candidate 评估 phase，不将通用作者运行伪装为旧 seed round。

主审独立运行 resolver 与 measurement 回归，2 文件 15 项通过。其中两条路径使用真实 AlgorithmRuntime 提交正常/取消完成，再经过 decision.reduce 后只读读取；另覆盖冷读不写、pending 不提升、链篡改、物理身份漂移和 resolver identity 不匹配。物理 reader 为受控测试实现，不是实际 Hitch 服务。

范围：只支持默认本地 CampaignStore 完整状态链；JournalCampaignStore 的增量后端需单独提供历史接口。真实宿主必须传入已冻结的 Hitch port，并核对其 manifest；完整请求由新 neutral Hitch journal 保存，旧 journal 不在 v2 恢复范围。
