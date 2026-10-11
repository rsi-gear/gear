# 算法框架实施状态

默认作者模型已迁移为 `gear.algorithm.step.v1`：Python/TypeScript 返回显式 JSON 状态与一批服务请求，使用同一 AlgorithmRuntime/Campaign 操作日志。默认 CLI、脚手架、包入口与作者文档均使用此模型。旧整段 replay、ManagedCall、AST 源码禁令及专属解析/worker/SDK路径已移除。

保留 CAS/Binding、任务用途授权、物理 Git/Hitch/DSH provider、预算预留与可信回执、unknown inspect/reconcile 和可信 measurement。服务适配器只保存当前活动批次及引用；它没有第二套事实历史。运行并发按单一 Campaign 设置限制实际在途操作，主操作与辅助操作共用容量；状态未变的轮询不重复提交。

通用物理 host 使用标准 ExperienceView，提供真实题面、作者任务选择与模型证据工具。`createDshModelServices` 装配既有模型角色和 workspace editor，不按算法名称分支。best-of-N、GEPA/RHO/DGM 风格教学例子共用同一 host。旧 FCS/科学 recipe 的必要内部兼容和差分测试仍保留。

可核验入口：`tests/unit/algorithm-step.spec.ts`、`algorithm-concurrency.spec.ts`、`algorithm-author-python-kill.spec.ts`，以及原可信测量、预算、物理 provider、FCS 差分/修复测试。`scripts/check-algorithm-package.mjs` 从 npm tarball 和 Python wheel 在仓库外运行默认 CLI 和三个示例，并对真实 `.ts` 示例进行严格类型检查。

本页不把录制宿主测试算作真实模型或 daemon 验证。恢复不包含任意 Python 堆、协程、模块缓存或跨版本迁移；未封存的物理模型 turn 可能需要外部对账。当前 API 与数据集 v1 执行支持的具体使用方式见[作者指南](algorithm-authoring.zh-CN.md)和[物理宿主示例](../examples/algorithms/step-search/README.md)。此前 v4 文档和实验审计保留为历史证据，不代表当前默认接口。
