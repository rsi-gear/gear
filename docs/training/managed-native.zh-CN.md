# 受管原生候选部署

v2 controller 可显式选择 `managedNative`。Gear 使用节点已有的 CAS、SSH/RPC 与 Supervisor 启动单个 SGLang TP 服务，自动生成不可变 ready binding，再交给 Hitch 执行评测。GPU 节点不需要 Docker；Harbor 和 Agent 仍在控制端的 `local-docker` 中运行。训练保留自己的 Slime、ExactGateway、policy lease 和训练端口。

当前交付一个 Supervisor 后端；systemd、多副本路由和动态 GPU 调度未作为配置选项提供。CPU 软件测试使用真实 Supervisor 4.3.0 和 GNU timeout，以及受控 HTTP/子进程；它们没有验证 SGLang 权重加载、GPU 数值学习或完整 Agent 容器拓扑。

## 固定环境与 profile

在 GPU 节点一次性安装对应源码版本的 Gear 与 `deployment` 可选依赖（锁定 `supervisor==4.3.0`），以及已选定版本和依赖锁的独立 SGLang Python 环境。普通推理环境与 Slime 训练环境分开。模型启动时不安装、升级或替换依赖。目标主机需要 Linux、`nvidia-smi` 和 GNU coreutils 的 `timeout`；控制端和模型节点时钟应同步，未来超过五秒的创建时间会被拒绝。[SGLang 原生安装](https://docs.sglang.io/docs/get-started/install)

原生环境锁由实际选定的 Python 生成，包含包版本、安装记录、Gear bridge、Python/平台身份和 deadline utility 的完整文件摘要：

```sh
python -m gear.training.cli.native_deployment runtime-lock \
  --python /opt/sglang-eval/bin/python \
  --supervisor-python /opt/gear-node/bin/python \
  --timeout /usr/bin/timeout
```

可从[完整 profile 模板](../../examples/training-loop/managed-native/profile.template.json)开始，或在节点运行[生成脚本](../../examples/training-loop/managed-native/prepare-profile.py)。脚本使用已有 `node-probe` 的 JSON 和 `seal-hf-node` 返回的模型描述，将真实环境与 tokenizer/template 摘要写入私有 profile：

```sh
python examples/training-loop/managed-native/prepare-profile.py \
  --output /workspace/gear/evaluation-profile.json \
  --node-identity /workspace/gear/node-probe.json \
  --sealed-model /workspace/gear/initial-model.json \
  --eval-gpu GPU-实际推理卡UUID --training-gpu GPU-实际训练卡UUID \
  --python /opt/sglang-eval/bin/python \
  --supervisor-python /opt/gear-node/bin/python --timeout /usr/bin/timeout
```

模板中的 `qwen25` 是需要按模型选择并验证的解析器示例。编辑 `engineArgs` 后同步生成 `serviceConfig.engine_digest = digestJson({environmentDigest, engineArgs})`；工具与推理解析器字段必须对应真实参数。generation 与公开 service config 复用 ready binding 的严格解析器。未列入允许集合的参数会被拒绝，不能覆盖模型路径、认证、监听地址、GPU、入口或开启动态模型代码。

将同一完整对象同时放入控制端 `controller.managedNative` 和模型节点 `node.json.nativeDeploymentProfiles[profile.name]`。节点只执行其私有配置中固定且摘要完全匹配的 profile，RPC 不传任意启动命令。控制端在 `deployment.nodes[profile.nodeRef]` 配置连接；profile 的 `nodeId/generation` 必须来自该节点的真实观察。

同一节点的 `trainingGpuUuids` 必须等于实验冻结的 `resources.trainingDevices`；evaluation UUID 与实际训练集合不相交。独立评测节点的训练集合可为空。不同 `resourceGroup` 的评测集合也不能相交，同一个组的多个 profile 必须固定同一组设备。TP 大小等于评测 UUID 数量。观察到其他 GPU 进程、端口占用、环境漂移、快照不完整或磁盘不足时返回明确失败并保留诊断。

控制端配置中只选择 `managedNative` 或 `evaluationBindings` 之一。原有 external-file 实验不自动获得启动权限。配置完成后调用：

```sh
gear training freeze-evaluation-profile --config /srv/gear/controller.json
```

将返回的 `endpointPreparation={mode:"managed-native",profileDigest:...}` 放入新建实验 spec。公共比较条件仍分别取 `digestJson(profile.endpoint.serviceConfig)`、`digestJson({api:profile.endpoint.api})`、`digestJson(profile.endpoint.generation)` 与 Hitch budgets 的摘要；节点、端口、UUID、实例名与认证引用不加入普通质量比较条件。

## 三种部署位置

| 形态 | 控制端与任务 | profile 节点连接 |
| --- | --- | --- |
| 本机 Docker + 外部 GPU | 本机 Gear/Hitch/Harbor/Agent，保持本机运行 | `transport.type="ssh"`，固定 Host 别名 |
| 常开服务器 + 外部 GPU | 常开服务器 Gear/Hitch/Harbor/Agent | 相同 profile 合同，使用该服务器的 SSH 配置 |
| Linux GPU 服务器一体部署 | 同机 Gear/Hitch/Harbor/Agent，静态分卡 | `transport.type="local"`，localPort 等于 nodePort |

profile 端口必须与 `deployment.nodes.*.gateway` 训练端口不同。普通 SSH 路由单独保存在实验私有 `endpoint-routes` 中，以 incarnation 区分；训练仍使用 `node-routes`。容器经 Hitch 已有的宿主代理访问模型，不能把容器 loopback 当作 GPU 节点，也不硬编码单一 Docker 宿主地址。关闭普通隧道只释放连接。

默认模型留在同一模型节点 CAS，部署对 digest 目录执行完整 manifest/size/hash/safetensors 核验后 materialize 为只读快照。普通观察核对已验证目录的 inode、size、mode、mtime/ctime，首次 ready 再次完整验证，避免每次轮询重读全部权重。不同评测节点复用现有 CAS 上传/下载工具完整传输：需要时先从训练节点下载至控制端 CAS，再上传目标节点；原节点已有完整快照时不搬运权重。失败或中断的传输不会发布部分对象。

## 就绪、共享与回收

Gear 在本地私有记录中先保存 intent、控制序号、首次启动期限、总期限及 per-incarnation 密钥，再调用节点。节点保存最终真实 argv、Supervisor 配置摘要和启动意图后才发送启动请求。超时或回执丢失先观察同一 intent/program；已启动实例按原身份补齐，不能凭超时再造服务。

就绪同时要求只读快照证明、真实 GNU timeout/SGLang 进程命令、实际环境/设备与进程组身份，以及 Hitch 的文本、SSE、串行工具调用和工具返回探针成功。`/models` 回显不能代替权重证明。Hitch 保存与冻结 revision 对应的宿主私有凭据，预先启动的 daemon 和重启后的 daemon 都能读取；公共 binding、任务包与证据只包含认证引用。

每个评测 attempt 在提交前登记独立 consumer，终态并确认请求结束后释放。取消一个任务只释放它自己的消费，其他任务继续使用同一模型。retire 先在节点组锁内关闭 admission，进入 draining；存在任何未释放 consumer 时保持服务。所有消费者结束后通过 Supervisor 对精确自属进程组发送 KILL，并验证记录的 PID/创建时间、进程组、子进程及 GPU 自属计算进程已消失后才标为 released。未知身份、网络不明或停止超时保持 blocked，不杀其他进程。此处是已 drain 后的明确强制停止，不宣称优雅退出。[Supervisor 组停止配置](https://supervisord.org/configuration.html)

每个 program 使用 `autostart=false`、`autorestart=false`、`startretries=0`。GNU timeout 在原始总期限发出 KILL，控制端离线也生效；期限触发记录 `deployment-hard-deadline-exceeded` 失败。该工具使用默认组语义，不使用会改变子进程超时范围的 `--foreground`。可检查[生成配置形态](../../examples/training-loop/managed-native/supervisor-program.template.ini)。[GNU timeout 说明](https://www.gnu.org/software/coreutils/manual/html_node/timeout-invocation.html)

实例死亡只有在进程与 GPU 的死亡证明充分时才返回可修复状态；不确定状态保持错误。控制器先协调旧任务、释放消费并确认旧服务 released，再创建显式新 attempt。新实例轮换 wire model、认证引用与密钥，即使复用端口，旧 binding 也不能命中新模型。冷启动重试共用首次 startup deadline；曾 ready 的实例恢复可获得总期限内的有限启动时间片，所有重建共享原始 hard deadline 和 `maxDeploymentAttempts`，不会刷新驻留预算。历史 binding 与消费记录保留，不能原地替换活动评测。

服务在 ready 后、评测 attempt 登记前死亡，也由部署准备阶段协调恢复：确认死亡、等待全部消费者结束、退休旧实例后，才消耗剩余部署尝试建立新实例。不能因尚无评测 attempt 而永久等待历史 ready 记录；未知状态仍不能作为重建依据。

远端服务释放与本地 SSH 连接清理分别持久化。若控制器在两步之间退出，重启后仍须清理原 incarnation 的隧道；旧版只有 `released` 的记录也按连接清理未确认处理。隧道清理失败时保留可重试状态，不返回整体释放完成，不开始占用同一端口的新实例，也不交还资源组所有权。重复清理只作用于原实例的专属路由，不停止模型服务或其他实例的隧道。

暂停先持久化更高的 pause 序号，再协调远端 fence 和资源停止。迟到的 start、ready 和 consumer admission 被拒绝；没有收到 consumer 心跳不能清空它。每轮卸载服务保留整个实验对资源组的所有权。只有实验终态在确认全部服务与消费释放后，显式 `releaseOwnership` 才能交给另一个实验；退役 owner 的 tombstone 永久拒绝迟到启动。单轮手动使用的程序调用者也应在实验结束后显式释放所有权，暂停不释放它。

## 软件验证与后续实机验收

Linux CI 安装 `python[deployment]`，系统提供 `/usr/bin/timeout`。macOS 安装 GNU coreutils 后设置 `GEAR_TEST_TIMEOUT`。关键进程测试缺依赖会失败，不静默跳过：

```sh
PYTHONPATH=python python -m unittest discover -s python/tests -p test_native_deployment.py -v
npx vitest run tests/unit/training/native-deployment.spec.ts
```

实机验收需保留实际 GPU UUID、环境锁、Supervisor 命令与子进程、HF/checkpoint 闭包、完整 Hitch/Harbor trial 及每轮决策证据。至少跑两个不同 run；检查真实 optimizer/scheduler/RNG/cursor 恢复、静态分卡、基线证据命中时无部署，以及一次任务取消后其他消费仍完成。再分别注入启动回执丢失、控制端重启、服务死亡与暂停竞态，确认没有重复训练、静默换 binding 或误报清理。软件测试通过不改变原有 `pending-gpu` runtime 门禁。
