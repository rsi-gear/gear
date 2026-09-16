# 任务与评测

开始进化前先准备任务集。Gear 固定数据内容和评测配置，后续轮次不能静默改变实验条件。

## 从一题扩展到完整评测

使用包含 instruction、environment 和 verifier 的 Harbor 兼容任务集。先运行一题并检查 verifier 输出；模型请求成功不能证明任务环境与评分已经正常。

AutomationBench 需要通过对应 Hitch 版本的 benchmark-package 导入工具转换，不能把原始 Python 仓库直接当成 Harbor 数据集。参考 [Hitch benchmark packages](https://github.com/rsi-gear/agent-hitch/blob/main/docs/benchmark-packages.md)，并检查实际安装版本的 importer help。保留上游提交、导入器/runtime 身份、task IDs 与数据集 digest。Harness 下载不包含历史 100 题导出数据。

## 导入一个 Marketing 任务

下面固定实验使用的 Hitch adapter 与上游版本。先启动 Docker，从 Gear 仓库根目录运行；导入过程会构建镜像并安装依赖，但不会调用模型。输出目录必须不存在。

```bash
git clone https://github.com/rsi-gear/agent-hitch.git ../hitch-marketing-guide
git -C ../hitch-marketing-guide checkout 67c527b9321e37755c77ee50545af4b9524ec731
node ../hitch-marketing-guide/benchmark-packages/automationbench/import.mjs \
  --source https://github.com/zapier/AutomationBench.git \
  --ref 4a8e1061254004d9dac807054eed33fad7d1ff14 \
  --task marketing.social_engagement_response \
  --out "$PWD/.evolve-lab/marketing-guide/one-task"
```

将生成目录传给快速开始中的 `GEAR_SMOKE_DATASET`。完整 100 题实验需要显式选择全部任务，并保留导出清单；单题运行不代表完整 benchmark 分数。适配器参数见[固定版本说明](https://github.com/rsi-gear/agent-hitch/blob/67c527b9321e37755c77ee50545af4b9524ec731/benchmark-packages/automationbench/README.md)。

## 按用途划分证据

| 数据集 | 使用者 | 用途 |
| --- | --- | --- |
| Seed/dev | Meta 与搜索算法 | 诊断失败、选择修改。 |
| Held-out | 晋升控制面 | 在未暴露给 Meta 的条件下验证 finalist。 |
| 公开研究集 | 明确声明的研究实验 | 研究已知题集上的迭代效果，报告其参与过优化。 |

使用互不重叠的目录；必要时也按任务 family 分离。同一批任务再次评测不构成独立测试。两个 Marketing 案例都明确使用全部 100 道公开题作为研究集，展示同集迭代效果。

## 固定评测条件

记录模型和 effort、Harness 版本、任务版本、评分规则、重复次数、timeout 与 runtime。并发影响资源使用，模型和采样影响结果；Gear 与 Hitch 必须对实际执行策略保持一致。

```yaml
seedTaskRef: /absolute/datasets/seed
heldOutRef: /absolute/datasets/held-out
taskBudgetMs: 3600000
hitch:
  attempts: 1
  maxConcurrent: 4
  setupTimeoutMs: 1200000
```

修改已封存条件后应创建新 evolution。`continue` 不重新加载全局数据集、模型或预算默认值。

## 复用与修复

证据身份和逻辑 `(task, attempt)` 槽位一致时才能复用。有效零分需要保留；缺失或基础设施无效槽位通过 `rerun` 修复，保留原始失败及有效证据。物理执行次数与最终计分题数分别统计，见[理解结果](results.md)与[管理进化](evolutions.md)。
