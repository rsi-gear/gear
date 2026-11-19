# 第三次切分：训练基线饱和，未进入优化

本次训练基线通过 8/8，不符合预先声明的 25%–87.5% readiness 范围，因此停止。没有运行数据生成、候选搜索、dev 或最终 test 评测，也没有改变门槛后继续。该结果不提供数据策略的比较结论。

使用冻结提交 `a308c78ab`，student/teacher 配置为 `gpt-5.6-luna` / `gpt-6-astra`，effort `low`；切分 seed `20261122`，至少一个约束，8 train、16 dev、24 test，排除前两轮及探索实验共 160 个来源。校准采用按约束构造反例，官方语言检测 seed 0；结构化输出已配置，但本次未进入 teacher 调用。

8 个学生调用全部完成，用量均已收到，共 72,586 tokens（含 cached input）。归档器核对冻结训练集、初始 harness、学生身份、意图／回执和官方评分，8 条记录全部复现。最终测试调用为 0。原生 HTTP 重试次数仍未知。

记录见 [evidence.json](evidence.json)、[manifest.json](manifest.json) 和 [第三方来源](NOTICE.md)。后续切分继续排除本次全部 48 个来源，累计排除 208 个；不会将这次基线饱和的运行从研究记录中删除。
