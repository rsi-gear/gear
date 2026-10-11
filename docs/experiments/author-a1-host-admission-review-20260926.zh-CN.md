# A1 运行锁与宿主准入审计

新增独立的 authority、目标路由声明和运行作用域合同，为通用宿主装配提供输入。

管理员预先提供两份不同、至少 32 字节的任务/证据签名密钥。准入只读取，不生成；运行锁保存路径和内容摘要，不保存密钥或目标模型凭据值。目标路由与冻结的 Hitch executable/root/model/agentArgs/passEnv 必须一致，显式标记 `configuration-only`；该检查不证明模型可连通。已知只支持 direct 的 bundled Codex wrapper 被明确拒绝用于 daemon 提交。

preview ID 只依赖静态输入，先于 provider 身份生成，避免 scope 与最终 lock 的依赖循环。实际 run ID 和前沿容量需显式指定，容量进入锁；没有选定新的发布默认值。最终锁采用同目录临时文件完整写入并 fsync，再无覆盖硬链接原子发布；已有锁不被覆盖。写入前限制锁大小并检查运行路径，读取从保存锁的确切路径与摘要开始。

主审独立执行 host-admission、physical-inspection 两文件，共 14 项通过，包括旧锁、部分文件、漂移、symlink 路径和超大锁。扩大到 resolver 后总计 19/20；唯一失败来自另一并行 schema 扩展使旧测试的 `minimum` 负例变成合法语法，已交给该切片修正，非准入代码故障。实施者的全仓类型检查曾被仍在实现的 composition 测试类型错误阻断，故本报告不宣称全仓通过。

本片段提供锁与准入 helper。完整 generic host、从冻结 commit 恢复而不重新解析 main、CLI 持续驱动及真实模型/Hitch 接线仍需后续实现验收。
