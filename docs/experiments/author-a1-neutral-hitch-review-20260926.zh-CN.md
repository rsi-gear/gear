# A1 中性 Hitch 执行切片审计

结论：可独立提交；真实服务与完整作者流程仍需后续验收。

HitchRolloutPort 新增冻结 author plan，直接承载 Campaign、编译数据集、模型、重复数、预算、sandbox 与签名任务来源，不构造 EvolutionSpec/RefinementRound。HitchCliEvaluator 接受独立 author context，使用 author-candidate phase 和包含完整 operationId 的提交身份。现有物理 condition 协议的 partition=seed 标签继续使用；研究用途仍由 profile 与签名 development TaskView 约束，不代表重建旧 seed round。

新 v2 journal 在首次 intent/取消记录中原子保存完整 EvaluationRequest；后续保留其摘要与提交/完成身份。readAuthorRolloutJournal 使用 FD 有界读取，仅返回已保存记录，不准备数据集投影、不 dispatch、不联系 daemon。可与已提交 Campaign 历史解析器配对。旧 journal 不作为 v2 请求来源。

主审独立验证 6 文件 43 项通过：中性 Hitch、原 fresh/Skill overlay、数据集物化、可信 measurement 与 committed resolver。中性测试执行真实 Git/数据集与录制 Hitch CLI 协议，冷重建端口后读取完整请求，调用次数不增加；请求摘要篡改被拒绝。实施者报告全仓 TypeScript 类型检查通过。

本片未运行真实 Hitch daemon、付费模型或额外 SIGKILL 实验；TaskView 来源为可信测试夹具。通用宿主须组装实际任务来源、route、角色、解析器和measurement，并完成真实小评估后才能称为可运行作者流程。
