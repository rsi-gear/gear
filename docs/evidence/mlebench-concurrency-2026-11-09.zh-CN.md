# 同任务并行与资源隔离验收（2026-11-09）

真实 Linux Docker 验收通过，未调用模型。正式对照包含 9 次完整任务；另保留 1 次启动中断前已完成的任务，并在最终代码快照上追加 3 次验证，共 13 次实际任务执行。[完整机器证据](mlebench-concurrency-linux-2026-11-09.json)记录所有 run、容器、产物摘要和工作目录。

| 对照 | 完整任务数 | 实测同时活跃实验峰值 | 所有实验共同重叠窗口 |
| --- | ---: | ---: | ---: |
| serial | 2 | 1 | 0.000 秒 |
| parallel-fresh | 2 | 2 | 28.733 秒 |
| cross-candidate | 2 | 2 | 28.942 秒 |
| native-same-eval | 3 | 3 | 27.795 秒 |
| 最终代码快照复验 | 3 | 3 | 28.769 秒 |

每次实验的主环境为 1 CPU／1024 MiB，独立 verifier 为 1 CPU／256 MiB。Docker `HostConfig` 观察值、Agent 内 cgroup 和封存执行记录一致；每次保留 2 CPU／1280 MiB／2 个容器槽。daemon 上限为 3 个任务、6 个容器槽和 2 个构建槽，三次同时执行的保留额度为 6 CPU／3840 MiB／6 槽。任务及 CLI Agent 时限均为 3600 秒，verifier 另有 120 秒时限。

每个 sandbox 在相同的 `/app/concurrency-marker.txt` 和 `/output/concurrency-marker.txt` 路径写入不同标记，等待 30 秒后复读，并输出起止时间与 hostname。所有标记保持独立；候选 A/B 的输出归属正确；run 目录、容器 ID、Compose 名称、产物清单和工作目录相互独立。完成后的 materialized workspace 全部清理，旧产物清单的字节摘要保持不变。人工等待用于观察任务重叠，不是模型训练吞吐量测量；使用的是确定性 `DummyClassifier`，不能据此推断 Titanic 质量。

首次双并行尝试暴露了并发 `worker observe` 与 Hitch 宿主探测锁的冲突。Gear 修复为按宿主串行发起独立的新探测，并只对明确的 `execution_observation_busy` 响应作有界重试，提交和模型执行不会被此机制重试。该尝试中一槽已完成，另一槽未启动。重启验收进程后，完整宿主环境绑定不再匹配，旧操作按规则拒绝继续；未绕过身份校验，未重新执行已完成槽。旧记录保留，之后使用明确的新 operation 进行双并行对照。原生 CLI 最初漏写 `--daemon`，也在启动任务前被拒绝；修正命令后才开始三次原生执行。这两类启动前拒绝不计作额外任务执行。

最终通过的 Hitch runtime 为 `sha256:360e4b2884e6ca010223ac6f594f3f973232cabc268fec7db6a81730684b0d31`，相对于最初快照只包含职责提取；其三次原生执行的 eval 为 `eval_026f93f40cce4b24ad78d083af737699`。最终 runtime 路径和原始结果保存在 `/private/tmp/gear-mlebench-concurrency-20261109/final-runtime/`。这份证据不包含后续真实模型运行的评分。

从新的输出目录复现：先构建 Gear 和 Hitch，配置可用的固定 Linux 镜像及资源宿主，然后运行：

```sh
HITCH_SOURCE=/absolute/agent-hitch \
HITCH_HARBOR_PATH=/absolute/harbor \
HITCH_RESOURCE_CONFIG=/absolute/resource-config.json \
GEAR_PYTHON=/absolute/python3.12 \
CANARY_IMAGE=registry.example/runtime@sha256:PLATFORM_DIGEST \
node tests/integration/canaries/mlebench-concurrency-linux.mjs /absolute/new-canary
```

主脚本执行串行、双并行、跨候选和原生三并行，并检查实际资源与产物。`mlebench-concurrency-continue.mjs` 保存本次中断记录并继续新的对照；它不是通用恢复 API。`mlebench-concurrency-resnapshot.mjs` 用于代码变化后，从已完成验收生成新的不可变 runtime 并追加三次验证，保留原有证据。

同 task 并发只适用于宿主验证支持 `hitch-attempt-isolation@1` 的本地 Docker 任务；无法证明固定名称、宿主资源或外部挂载可隔离的任务，以及当前远端 worker，保守串行。可配置的并发数始终是上限。
