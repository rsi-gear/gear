# 配置参考

首次创建 evolution 时明确配置。Gear 在 admission 封存实验身份，continue 时重新核验。

## 必须确定的部署字段

| 字段 | 填写内容 |
| --- | --- |
| `workspaceRoot`、`stateRoot` | 独立的绝对工作区与持久状态路径。 |
| `dshRepository`、`targetRoot` | Target Git 仓库及可编辑目录，通常为 `harness`。 |
| `dshBaseRef`、`initialChampion` | bootstrap 输出的 substrate、champion commit、manifest digest。 |
| `toolchainRef`、`sandboxProfileRef` | 固定构建和隔离条件的稳定身份。 |
| `seedTaskRef`、`heldOutRef` | 版本化数据引用或本地任务目录。 |
| `metaModel`、`metaSampling` | Meta provider/model，以及可选 temperature/effort。 |
| `metaAdapter` | Skill 模式和外部显式身份，或 DSH 派生身份。 |
| `compiler` | 绝对可执行路径、参数、timeout 与 runtime 检查协议。 |
| `hitch` | CLI、root、Target model、attempts、setup 与并发。 |

使用 [Standalone 完整模板](../../harness-agnostic-refine-skill.md)或 [DSH profile](../../../examples/dsh-codex-luna/profile.patch.yml)。两者属于不同配置入口，不能把 YAML 插件行直接粘贴进 JSON server 配置。

## 不同预算的范围

| 配置 | 作用范围 |
| --- | --- |
| `taskBudgetMs` / `--budget` | 一次 Target task attempt，默认 3,600,000 ms。 |
| `hitch.setupTimeoutMs` | 任务环境准备。 |
| `candidateGeneration.attemptTimeoutMs` | 一次 Meta candidate attempt。 |
| `candidateGeneration.maxAttemptsPerCandidate` | 每候选生成尝试次数。 |
| `candidateGeneration.roundTimeoutMs` | 本轮候选生成总期限。 |
| `candidateGeneration.maxCandidates` | 每轮候选槽位。 |
| `selection.survivors` | 从已评测候选中保留的研究 survivor 数量。 |

时间上限不等于费用预算；重连不重置已用时间或请求。第一轮应根据模型账号限制和主机容量选择小规模任务。

## Direct 与 daemon

```yaml
hitch:
  root: /absolute/hitch-state
  controlPlane:
    mode: direct
```

支持 daemon 的部署应先为该 root 启动一个 daemon，再选择 `mode: daemon`，要求 Hitch 0.2.6+。凭据 wrapper 可能仅支持 direct，配套 DSH OAuth 示例即如此。提交的 profile 中不放秘密值；`passEnv` 只列变量名。

## 进阶路径

[Context offloading](../../dsh-meta-context-offloading-spec.zh-CN.md)适用于 native DSH Meta adapter，必须在新建实验前封存。[算法设置](example-algorithm.md)依赖对应搜索实现；[训练配置](training.md)使用独立 controller 合同。当前 checkout 的[源码 schema](../../../src/config.ts)是字段定义依据。
