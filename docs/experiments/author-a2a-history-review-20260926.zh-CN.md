# A2a 旧实验报告审计

`inspectHistoricalRoundReport` 从明确 state root 和 round ID 读取旧 round，复用现有结构验证，输出带原始字节 SHA256 的 `record-only` 摘要。它不启动旧 Gear worker、状态初始化、Hitch、模型或 CAS 导入。CLI 参数适配已提供，总入口另行接线。

报告分别记录 round 状态、评估证据完整性、无证据、候选封存状态和执行可用性。只从显式 reward 字段统计有效零分；无 reward 的多指标记录不猜主指标。旧文件中的 complete 仅表示结构完整，不等于当前物理结果已经重新核验。候选出现 sealedVersion 也只标记 not-verified，不能据此运行。

读取采用严格 UTF-8、有界 regular-file、路径约束、文件身份和两次字节一致性检查。相同字节的读取不修改旧目录。自由文本失败正文和完整轨迹不写入脱敏验收报告。

主审独立验证 report、nonwinner、data-history 三文件 18 项通过；另直接读取两份 A0 inventory 固定的真实旧失败报告，原 SHA 均匹配：每份基线 43 个有效 trial、0 个 invalid、27 个显式 reward=0，失败候选均未封存。整个旧 state 的五份文件前后摘要一致。实施者类型检查及隔离构建通过，真实摘要见 [脱敏 probe](author-a2a-history-probe-20260926.json)。

本切片完成旧 round 的报告读取范围。近期 Campaign archive 的完整展示、Hitch 原始物理复验、授权 Experience 投影和模型权重依赖闭包仍需分别验收，不据此宣布 A2 全部通过。
