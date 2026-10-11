# A1 只读物理环境检查切片审计

结论：可独立提交，尚不构成完整 AuthorCapabilityInspector 或可运行 lock。

新增与 EvolutionSpec 无关的管理员运行配置，以及 Git/Harness、标准 v1 编译数据集、Hitch capability 和 meta 模型注册的只读探针。Git 读取使用真实仓库与 HarnessBuilder 校验；数据集检查逐任务字节、manifest 摘要及整体稳定性；Hitch 只调用 version/status/capabilities；模型注册仅 resolveModelInfo，不生成内容。

主审要求并确认：聚合入口必须加载配置指定的冻结注册模块，不能用无关 callback 代替；配置、manifest 和模块使用 FD 有界读取并拒绝末端符号链接；未实现的评分设置明确拒绝。当前注册模块只支持单个无导入 .mjs，外部包闭包仍待实现。低层 meta probe 保留可信宿主 callback 接口，不可直接作为准入证明。

主审独立回归 4 文件 26 项通过，覆盖物理探针、fresh Hitch、数据集物化与身份。第一轮 16 项失败来自物化测试在编译后添加任务文件却未重新封存 manifest；已修正 fixture 的真实摘要，未放宽生产校验。Hitch 测试使用可执行的录制协议夹具，meta 使用离线注册适配器；不声称连接真实 Hitch daemon 或调用模型。

未完成：target 实际路由核验、provider 装配、完整 lock 发布/消费、外部 TS 装载和真实小评估。它们仍是后续验收门。
