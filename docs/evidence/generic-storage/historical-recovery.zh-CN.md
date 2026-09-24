# 命名历史实验的只读恢复

复现入口：`scripts/canary-historical-storage.mjs /absolute/gear /absolute/agent-hitch`，要求两仓库已 build，原保留清单和 Hitch home 可读。原始结果见 [historical-recovery.json](historical-recovery.json)。

| 保留实验 | 已完成验证 |
| --- | --- |
| initial：`marketing-unified-20260911` | 5 个 round；4 个候选物理评测恢复；共享 baseline/cache 原记录随 round 原样往返 |
| GEPA：`marketing-staged-20260912` | 3 个 round；23 个 immutable result source；20 个不同的原 absolute-ref projection；23 个物理评测恢复 |
| Luna Max：`marketing-luna-max-20260912` | 100 个 trial，50/100 |
| champion Luna Max：`marketing-champion-luna-max-20260914` | 修复后的 100 个 trial，53/100；保留原 eval ID 和修复结果来源 |

测试使用当前 Gear `RefineStateStore` 校验历史 round，在新临时目录写入并重新打开，确认内容完整相同。GEPA source 经当前 `SearchStore.object` 校验不可变摘要，并复制到隔离 store 再读取；当前 `projectDataset` 直接复用 20 个原 canonical，验证任务字节、manifest、路径和原返回摘要，没有生成新投影或改写 ref。

29 个物理评测的原 request/plan/result 等元数据复制到隔离 Hitch home，使用当前 Hitch `inspectEval`、Gear `HitchCliEvaluator.inspectResult` 和 `recoverExternal` 恢复。身份检查仍读取原 wrapper 字节，并只允许其 `--version` 调用；没有替换、伪造或跳过运行指纹。恢复结果的 provider、eval ID、dataset、commit、condition、effective config、invocation fingerprint、revision、completeness、reward 以及各有效 trial 的原字段逐项与保留证据比较。当前 parser 新增的 `originalResult` provenance 字段不算旧 trial 字段变化。

initial 的历史缓存 wrapper 在 Gear 中使用自己的 provider/config 身份；物理恢复使用其保留的原 `hitch-cli` evidence，并验证 sourceEvidenceHash 的对应关系。另复核四个缓存 evidence 的原始 JSON 字节序列化 SHA-256 预像，不把它与 Gear canonical digest 混用。原 wrapper 生成的合并 baseline 保存在原 round 中，不冒充一个新的物理 eval。

每个 eval 完成两次恢复后，在**隔离副本**暂时移走 result，再运行恢复，确认写入 unknown pending operation；重新打开 journal 后仍 unknown。还原 result 后再次恢复同一结果。新 reserve/evaluate/recoverReservation/cancel 和外部运行入口均设为失败哨兵，未发生任何新增评测尝试。

所有文件系统写操作限定在本次新建的临时目录。原实验不获取写锁，不运行旧 launch/run 脚本；读取过的 273 个原记录文件最终 SHA-256 全部未变。原 v4 dataset 与 20 个 projection 均按原 tree 算法验证。模型调用 0，额外评测提交 0。

该验证证明存储升级下已有结果和原 ref 的读取、恢复、复用；保留原 evaluator/runtime 语义。它不将旧 GEPA 的早期 search journal 自动迁移为新的搜索语义版本，也不启动已经结束的历史实验继续生成候选。
