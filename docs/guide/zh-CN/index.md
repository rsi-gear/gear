# Gear 用户指南

本指南对应 Gear 0.2.2 及其基于项目的 API。
Gear 用 Python 定义优化策略，用持久运行层执行评测、候选生成、恢复和最终验证。
CLI、Python SDK、原生 DSH Skill 和项目 socket 调用同一个应用服务。

## 选择入口

- [快速开始](quickstart.md)：创建可编辑 benchmark，先做无模型检查，再试跑单题。
- [Python 算法](example-algorithm.md)：替换父代策略，或修改统一的六个算法模块。
- [Target Harness](target-harness.md)：选择 DSH 或 Pi 的原生资源边界。
- [模型训练](training.md)：通过 `gear.training` 使用独立的训练生命周期。

## 算法的六个修改位置

| 文件 | 控制内容 |
| --- | --- |
| `parents.py` | 父代、抽样概率和候选配额 |
| `sampling.py` | seed 任务集合和权重 |
| `proposal.py` | 诊断与候选计划 |
| `ranking.py` | 完整共同范围内的候选比较 |
| `stopping.py` | 搜索结束条件 |
| `algorithm.py` | 阶段顺序与策略组合 |

GEPA 和 RandomSearch 都实例化这些公共合同。TS 负责执行和固定校验，不提供另一套公开算法作者 API。
训练代码在 `python/gear/training/`，按基础合同、循环、存储、运行时、后端、数据、脚本入口等职责整理。

## 当前验证范围

静态 benchmark、CPU 策略测试、DSH/Pi 本机扩展加载和安装包离线旅程已有覆盖。
正式 Meta runner、认证引导、真实模型闭环以及原有高级指标迁移仍在完善；具体结果见
[实施记录](../../refactor-progress.zh-CN.md)。历史 Marketing 案例描述当时固定版本的研究集实验，不能当作当前接口教程或独立 held-out 效果证明。

继续阅读[配置](configuration.md)、[任务](datasets.md)、[运行管理](evolutions.md)、[报告](results.md)和[问题排查](troubleshooting.md)。
