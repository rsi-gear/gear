# DiagEvo 真实记忆后端验证

Codex 诊断与本地 BGE embedding 已跑通记忆提取、检索、节点分配和归并判断，并验证原生 turn 恢复及无新调用的重放。**本次没有训练模型，也没有测量能力提升。** solver 响应、actor 状态和训练提交来自明确标识的 CPU 合同 fixture；两个问题分别包含忽略定义域和忽略条件概率的失败。

真实执行的模型为 `gpt-6-astra`（OpenAI provider，effort `low`）和 [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5/tree/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a)。BGE 文件固定于 revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`，实际字节摘要另行核对；采用 CPU float32、归一化 CLS、最长 512 tokens、不截断。这个 embedding 选择不代表复现论文默认配置。诊断回执保留服务端返回的模型名称，但它不提供不可变服务端权重版本。

## 两版结果与用量

| 运行 | 状态 | 原生诊断 turns | 原生 input+output tokens | 本地 embedding |
| --- | --- | ---: | ---: | ---: |
| V1 | 恢复校验中止，原 turn 已完成 | 1 | 11,143 | 0 |
| V2 | 记忆更新、恢复与重放通过 | 5 | 53,383 | 4 |
| 合计 | 保留两版实际调用 | 6 | 64,526 | 4 |

V2 原生 input 为 53,237、output 为 146，cached input 和 reasoning output 均为零；所有五次均保存 usage。四次 embedding 共 60 个输入 tokens，384 维向量的范数范围为 0.999999972–1.000000076。累计前向推理时间约 0.0602 秒，不含模型下载、加载、tokenization 和总流程耗时。金额来源不可用，`usd=null`；逻辑 turn 数不等于 SDK 内部 HTTP 请求数。

V2 五个诊断依次完成两个失败提取、一个新原因去重、一次节点分配及一次归并判断。原有原因被重新激活，另建立一个条件概率原因和节点；最终共有两个 active 原因、两个节点。模型选择不合并这两个节点。这只是此组输入上的实际决定，不是诊断准确率评估。

## 原 turn 恢复与首版缺陷

探测器在第一次诊断已完成、usage 已写入之后，故意在本地结果回执保存前中断。随后关闭 SDK client，再用新 client 读取原 thread，核对原 turn 和输入后继续。V2 的恢复记录与注入点具有相同的原生 thread/turn ID；总计仍只有五个 turn，没有为中断的 key 再次生成结果。最后断开诊断 client，完整重放返回相同 CAS 制品；探测器只有在这个断言成功后才写入 `result.json`。

V1 暴露了恢复校验问题：本地 JSON 写入排序字段，恢复时重新序列化文本与最初提交文本顺序不同，尽管 JSON 值相同，仍被当作输入漂移。原生 turn 已完成，恢复却中止。只读审计取回该原 turn，没有重新调用模型，也没有把 V1 改记为通过。

修复后在提交前保存实际发送的 `userText`，恢复时同时核对逐字文本和解析后的 JSON 内容；新增回归测试使用不同字段顺序。V2 在修复后的源码身份下单独运行，V1 的源码、输入、原 turn 和 11,143 tokens 均保留。两版总共六个逻辑 turn，未因首版中止隐去其用量。

## 证据范围

- [manifest.json](manifest.json) 保存核验项目、数量、限制和证据文件摘要。
- [evidence.json](evidence.json) 保存两版精确源码快照，V1 中止记录及原 turn，V2 请求／响应／usage、记忆输入输出及调用侧录、最终 CAS 引用和 BGE 文件摘要。这里的 native ID 是调试记录身份，不构成第三方服务的独立审计证明。
- [实际探测入口](../../python/probes/diagevo_memory_smoke.py) 明确依赖测试 fixture，不能作为生产双模型配方。源码基线为 `55bc83922`，本次新增源码的实际字节与记录中的摘要一致。

导出前从原工作区读取并核对了最终 CAS 内容、全部九份后端回执、原生请求与记忆输入输出、唯一 turn、完整 usage、恢复身份、四个向量及六个 BGE 文件摘要，并执行 `DiagEvoMemoryUpdater.verify`。导出不含模型权重和完整 synthetic capture CAS；两者留在原运行目录，所以此小型归档不能单独重放完整训练数据来源图。未导出认证配置或凭证。

原运行目录为 `/private/tmp/gear-diagevo-memory-smoke-20261120-v1` 和 `/private/tmp/gear-diagevo-memory-smoke-20261120-v2`。已完成运行的稳定 key 不应删除后重试；新实验需使用新的独立目录，并明确承担新的模型调用。

## 当前验收结论

实际诊断、embedding 和已提交失败材料的记忆更新函数可用；92 个 DiagEvo 回归测试通过。完整外层仍缺 challenger 更新与更新后新采样、冻结 solver 构造采样、记忆制品发布和下一轮作业衔接、跨作业恢复及 GPU 效果验证。见[实施台账](../../docs/curriculum-implementation-status.zh-CN.md)和[接入文档](../../docs/training/diagevo.zh-CN.md)。这次通过不改变完整设计“尚未实现完毕”的状态。
