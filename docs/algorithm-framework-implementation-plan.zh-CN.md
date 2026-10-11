# 算法作者接口简化：实施计划

- 对外只保留显式状态 `step(ctx)`：读取上批 results，返回 `run(next_state, requests)` 或 `finish(result)`。普通 Python 计算与库可直接使用；未提交 step 的纯计算可重做。
- 唯一操作日志仍为 AlgorithmRuntime/Campaign。状态和意图原子提交；服务只保存当前有限阶段与引用，不积累 replay history。
- 共用能力 host 注入 sample/propose/evaluate/role。生成、测量保留 Git/CAS/Binding、provider 身份、预算、证据检查。接受与 archive 策略归作者。
- 默认 CLI、Python/TypeScript 脚手架和文档迁移；删除旧 ManagedCall、全历史 replay 与源码禁令。保留老科学 recipes 与可信测量。
- 验证状态恢复、lost reply、unknown、预算、并发 ≤20、零分与失败区别、非 winner 繁殖，以及已安装包和默认 CLI。
