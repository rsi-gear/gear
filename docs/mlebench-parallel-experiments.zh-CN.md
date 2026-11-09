# 同一任务的并行实验

Gear 的 Hitch profile 用 `maxConcurrent` 设置一次评估操作中跨任务和 repetitions 的并发上限。同一 Titanic 任务的两次重复执行可以同时运行。每次执行拥有独立的任务环境、Compose project、工作目录、参数状态、日志和 run 产物，不自动继承其他实验的模型或 checkpoint。

```json
{
  "maxConcurrent": 3,
  "timeoutMs": 3600000,
  "setupTimeoutMs": 1200000,
  "preparationTimeoutMs": 1200000
}
```

上述字段合并到完整的 `kind: "hitch"` profile。也可通过 `gear profile create NAME --kind hitch --adapter dsh ... --max-concurrent 3 --timeout-ms 3600000` 创建。并发参数进入冻结的执行身份，变更后创建新运行；已完成的实验记录保持原配置。

`maxConcurrent: 1` 顺序执行，`2` 最多同时执行两个 trial。每个 repetition 包含多个任务时，Gear 按该组可能同时执行的任务数预留容量，不将任务并发和 repetition 并发相乘。不同操作共同服从 Hitch daemon 的 CPU、内存和容器总容量。未确认结束的执行不会因 watch 断线而释放 Gear 的并发额度；恢复按原 eval ID 查询，不额外提交已接受的实验。

Hitch 在已验证的本地 Harbor 执行路径上检查同任务隔离能力，并对每个 work item 分配独立执行资源。显式固定容器名、共享外部卷、宿主端口或其他无法证明隔离的配置继续串行；未知后端不因调高并发值而绕过互斥。

## Titanic 当前资源预设

新任务配置使用以下值，训练数据仍为全部 891 行，私有 verifier 直接对照用户提供的 418 行真实标签：

```json
{
  "cpus": 1,
  "memoryMb": 1024,
  "timeoutSeconds": 3600,
  "verifierCpus": 1,
  "verifierMemoryMb": 256
}
```

| 每次实验 | CPU 上限 | 内存上限 | 时间上限 |
| --- | ---: | ---: | ---: |
| Agent / 训练环境 | 1 | 1 GiB | 1 小时 |
| 独立 verifier | 1 | 256 MiB | 120 秒 |
| 调度器合计预留 | 2 | 1.25 GiB | 两个独立容器槽 |

当前并行三次需要至少 6 CPU、3.75 GiB 可用内存和 6 个容器槽；构建另外占用 build slots。可按宿主实际容量启动调度器，例如 `hitch --root ROOT daemon start --max-concurrent 3 --container-slots 6 --build-slots 2`。CPU 和内存容量默认从 Docker 宿主检测，容量不足时排队；设置更大的并发数字不会增加宿主资源。

1 小时指 Agent 执行时间。排队、镜像准备、Agent 安装和 verifier 有独立时限，不把这些阶段伪装成 Agent 的训练时间。普通训练脚本可以在这一小时内运行多个内部建模动作。

此前已封存的 Titanic 运行采用不同资源值，仍保留作为历史证据。新的低内存配置必须重新导入生成新任务身份；不就地修改旧任务的哈希或结果。并行功能的真实 Linux 验证使用确定性 Agent，不消耗新的模型调用。

当前资源配置下的 [3 次真实模型验收](evidence/mlebench-parallel-model-2026-11-09.zh-CN.md)已完成，实测并发峰值 3，平均准确率 76.3158%，样本标准差 1.6746 个百分点。
