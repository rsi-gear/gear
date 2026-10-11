# A1 v2 Campaign 与双语言恢复接线审计

结论：本切片可提交；不是完整作者搜索流程的交付。

AuthorAlgorithmAdapter 和 TS/Python port 显式冻结 v2 wire、config schema、capabilities、需要的 operation kinds、执行 profile 与可信 Agent policy 摘要。初始和最终选中 HarnessAgent 经过 CAS binding、Harness 描述及宿主 Git verifier；选中项还需通过本 Campaign 来源 policy。输出/checkpoint 只遍历明确的 A1 schema 引用边，不声称支持任意历史制品或自定义 schema。

内核从实际终态 operation envelope 投影 completedOperationIds，v2 adapter 将其与结果一起封存到 replay history；TS/Python 都拒绝缺失、重复、非法 ID 和跨版本混用。内部 tracked rollout 保留业务失败的 outcome 和真实 ID，给后续评估组合使用。普通 operation 的值/异常语义保持不变，unknown 不被改成终态失败。checkpoint policy 已按主审意见复制并冻结，避免外部修改原配置改变校验。

验证：冻结副本 /private/tmp/gear-a1-v2-freeze-20260926 的作者切片文件与 live 逐文件一致。实施者在该副本直接 tsc 构建及类型检查通过，8 个 TS 测试文件 106 项和 Python 3.11 author 25 项通过。npm run build 的私有 tool-fs 依赖打包因离线失败，采用现有已生成 asset 加直接 tsc 构建，不记为完整 npm build 通过。

主审独立在同一冻结副本验证：v2 Campaign/parity 2 文件 13 项，以及内核身份、预算时钟/视图 3 文件 14 项通过。包含真实双语言 worker、丢回复与冷恢复原 key；受控 provider 不是模型或 Hitch 服务。先前 live 树一项源码闭包漂移来自并行修改，隔离后全部通过，没有放宽身份检查。

限制：当前 A1 基础 provider 集合仍是 Harness 搜索切片所需集合，后续须根据实际使用的 SDK 能力和静态声明派生，不能作为所有自定义/训练算法的永久全局要求。外部包装载、propose/evaluate/select 与真实宿主另行交付。
