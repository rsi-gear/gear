# Titanic 入口迁移

Titanic 统一使用 [MLE-bench 任务格式](../mle-bench/README.zh-CN.md)和 [data-analysis harness](../data-analysis-harness/README.zh-CN.md)。

旧版直接修改 Titanic 模型的 `prepare/start/finalize` 脚本依赖已删除的 Search/Refine 控制面，现已退役。请用 MLE-bench 的 `prepare-local` 准备数据，再运行新 `prepare.mjs`、`start.mjs --meta-profile NAME` 或 `compare.mjs --stage ID`。最终采用固定 C5，通过 `refit.mjs` 导出 submission.csv。

历史提交、实验记录和成绩保留在 Git 历史及验证文档中；旧 gear.config.json 不作为新 Project 配置导入。
