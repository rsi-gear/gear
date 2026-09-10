# 远程 Harbor worker：安装准备与验收边界

第 34 轮准备记录，2026-09-09。这里只准备 Linux worker 的安装输入，没有创建第二台 Vast 实例，也没有完成跨主机任务验收。第 32～33 轮的模型实例 `50316639` 保持停止。

## 已准备的输入

`python/probes/prepare_remote_harbor_worker.py` 在控制端生成：

- 官方 Node 26.7.0 Linux x64 归档及其发布 SHA-256；固定 uv 0.11.26 安装器及 PyPI SHA-256。
- Harbor 0.21.0 的 89 个 Linux / CPython 3.12 wheel。首次解析后的全部文件由 SHA-256 清单固定，VM 安装使用 `--no-index`；重新准备时应视为一套新输入，不能假设传递依赖仍相同。
- 真实 Hitch Git bundle、当前源码和编译 payload。保留原 HEAD 与 dirty 状态，不伪造源码身份；安装后必须与控制端实际 `training runtime --json` 完全一致。
- 本地已验证任务镜像的 `docker image save` 归档，固定 image ID 为 `sha256:7eafe3f4bc4c666a7d1816150fe65f2d8ec80ef4cf4034fd96cbcc32c33913c7`。
- 分离的 CPU 安装脚本与 VM Docker 观察脚本。二者都不租用实例、不启动 GPU、不注册 worker、不提交任务，也不修改系统 Python。

本轮产物位于 `/Users/tangyehui/.codex/artifacts/gear-remote-harbor-preparation-20260909-34`：100 个输入文件，共 1,652,830,204 字节。`worker-inputs.json` 与 `worker-inputs.sha256` 记录完整安装输入；传输前后还应使用控制端保存的清单摘要核对清单本身。生成示例：

```bash
python python/probes/prepare_remote_harbor_worker.py \
  --hitch /absolute/path/to/agent-hitch \
  --node /absolute/path/to/node-v26.7.0 \
  --image hitch/gear-native-two-tools-test:local \
  --output /absolute/path/to/new/prepared-inputs
```

`install_remote_harbor_payload.sh` 已在本地真实 Linux/amd64 容器执行成功：Node 26.7.0、Python 3.12.13、Harbor 0.21.0 安装完成，89 个依赖通过 `uv pip check`，安装后的 Hitch runtime 与控制端一致。测试容器没有挂载 Docker socket；这项结果只证明安装闭包，不能证明远程 Docker、SSH 或 GPU 链路。证据为 `cpu-install-check.json` 与其引用的原始日志。该脚本仍需联网安装固定版本的 Python；Node、uv、Harbor wheels、Hitch 与任务镜像已在本地准备。

## VM 准备

[Vast 官方 VM 文档](https://docs.vast.ai/guides/instances/virtual-machines) 提供 Ubuntu 22.04 VM 模板，支持 Docker/systemd；与普通 GPU 容器不同，VM 的 Vast copy 只支持 VM 之间整机迁移，不能复制单独文件夹。因此 worker 日志及状态应在停止 VM 前经 SSH 回收，并逐文件校验；已确认不可用且必须删除时，仍先保全必要数据。

本轮只读报价观察保存在 `vm-candidates.json`。最低候选报价约 $0.08954/小时、130 GB 磁盘，带 GTX 1660 Ti；这里使用它的 Linux / Docker 能力。报价可能变化，租用前必须重新检查实际总单价。第二台实例的付费授权尚待用户答复，不能根据该报价或安装通过自行租用。

上传已核验输入后，在专用 VM 上执行：

```bash
bash /absolute/prepared-inputs/setup_remote_harbor_worker.sh /opt/gear-worker-34
```

目标安装目录必须不存在。脚本先确认 Linux x64、Docker engine、Compose 和 buildx 可用，再校验输入、安装到专有目录、核对 Hitch runtime、载入原任务镜像，最后保存真实 engine、boot、软件版本和镜像身份。失败时保留目录与日志，先诊断再决定如何继续，不能把安装脚本失败当作实例不可用或自动删除依据。

## 下一步实测

1. 控制端 daemon 保持在本地，worker 在独立 VM；通过只绑定回环地址的 SSH 反向转发接入 daemon。实际观察并核对 worker 的 Docker engine 与本地不同，不用同机 worker 或 Docker-in-Docker 冒充跨主机部署。
2. 先在 GPU 停止时完成真实远程 Harbor 的两次工具调用、verifier、结果导入与资源释放。模型输出使用确定性 fixture 时明确标注，不能作为原生 token 或 GPU 验收。
3. 上述链路成功后才恢复模型实例，接入实际 native gateway，核对 policy/run/request/receipt/token/logprob，再运行远程 provider 的训练与独立评估。
4. 完整 remote capability 与 validated runtime 继续关闭；安装记录和 Docker 探测不替代 P4 的真实候选执行与恢复验收。

## 第 35 轮：SSH canary 已接入，真实跨主机仍待执行

Hitch 的 `scripts/canary-remote-training.ts` 和 `scripts/canary-native-training.ts` 新增可选 `HITCH_CANARY_WORKER_SSH_CONFIG`。未设置时保留原本地 worker 路径；设置后必须成功观察并启动指定 SSH worker，不会回退到本地。配置示例如下，所有路径都须按实际安装与 SSH 配置填写：

```json
{
  "ssh_host": "harbor-vm",
  "ssh_config": "/absolute/private/ssh-config",
  "runs_directory": "/opt/gear-worker-34/canaries",
  "node": "/opt/gear-worker-34/node-v26.7.0-linux-x64/bin/node",
  "hitch": "/opt/gear-worker-34/hitch",
  "python": "/opt/gear-worker-34/harbor/bin/python",
  "docker": "/usr/bin/docker",
  "remote_port": 32992
}
```

`canary-worker-host.ts` 在提交任务前核对远端任务 image ID、Harbor 版本、系统 boot ID、Hitch 完整 runtime 与不同的 Docker engine。公开 canary 仍从控制端创建新 daemon、绑定与任务；worker 通过只监听 `127.0.0.1` 的 SSH 反向转发访问该 daemon。注册凭据通过 stdin 传送，保存到远端 0700 目录中的 0600 文件，不进入命令行；模型上游凭据仍只在控制端。

`canary-worker-peer.ts` 在 Linux 上启动真实公开 `hitch worker run`，把每次 canary 的目录、owner、启动记录与 stop tombstone 独立持久化。重复启动、配置漂移、停止先到后的迟到启动均拒绝；停止前核对 `/proc` 的进程启动 tick 与系统 boot ID，不以 SSH 退出证明远端结束。peer 自带 8 分钟进程期限；它只限制 worker 进程，不能代替 Vast 实例的付费 watchdog。Docker 清理仍调用远端生产 reaper 并核对实际 root/lease，SSH 或释放观察失败不会写 `cleanup_proven=true`。回收只复制本次 worker 的普通文件，不把它当作完整 VM 备份。

第 35 轮证据位于 `/Users/tangyehui/.codex/artifacts/gear-remote-harbor-canary-preparation-20260909-35`：

- 8 项真实 Linux CPU 进程检查通过，包括停止先到、重复启动、真实进程停止、迟到启动拒绝、配置漂移、私有凭据与不误杀启动身份不同的进程。实际 worker 程序是 sleep fixture，没有运行 SSH、Harbor 或 GPU。
- 3 项配置、真实 shell 参数引用与 SSH 可执行文件 fixture 检查通过。确认单引号、空格、命令替换字符作为原始路径字节处理，凭据不在 argv，反向转发限定回环地址；这不是实际 SSH 网络证据。
- 原本地 Harbor 路径完成真实 Docker 工具执行与 verifier：eval `eval_15a789a51c1a4579983fc984bc1c8c9c`、run `run_74d8645343db4b158d40f49d35dd23e2`，3 次确定性模型 fixture 调用、2 次工具调用、reward=1，lease/Docker 清理确认。模型不是 SGLang，不能作为原生 token/logprob 证据。

`worker-canary-overlay.tar.gz` 封存新增/更新的诊断脚本及 source map，逐文件 SHA-256 位于 `worker-canary-overlay.json`。它应在第 34 轮安装完成后、启动 worker 之前校验并解包到远端 Hitch 目录。生产 runtime payload 未变化，仍为 `sha256:737cae01ef33578417f2ae2a9f825a68cc893d64139c34c6affe55becec9cd0e`；原第 34 轮安装输入与校验记录保持不变。后续使用准备脚本从当前 checkout 重新打包时，新的 payload 归档会直接包含这些诊断脚本。

第二台 VM 尚未租用，真正的 SSH/远程 Docker/native gateway 验收仍待可用主机及相应授权。模型实例 `50316639` 继续停止保留。

## 第 36 轮：Vast VM 执行脚本准备

`python/probes/vast_harbor_worker.py` 已串联报价检查、VM 创建、SSH、安装输入传送与 SHA-256 核验、第 35 轮脚本覆盖包、远程 Harbor canary、证据回收及停止保留。**付费路径尚未执行**；默认不带 `--run` 时只校验本地输入、读取 Vast 当前状态/报价并写 `plan.json`。计划文件明确 `authorizedByThisFile=false`，不能作为新增实例的授权。

准备示例：

```bash
python python/probes/vast_harbor_worker.py \
  --vast /absolute/path/to/vastai \
  --node /absolute/path/to/node-v26.7.0 \
  --hitch /absolute/path/to/agent-hitch \
  --harbor-python /absolute/path/to/harbor/bin/python \
  --inputs /absolute/path/to/preparation-34 \
  --overlay /absolute/path/to/preparation-35 \
  --model-instance 50316639 \
  --output /absolute/path/to/new/execution-record
```

执行路径限 VM 单价不超过 $0.12/小时、总期限不超过 45 分钟；准备与 canary 期间原模型实例必须保持停止。选择不同物理 machine 的 VM，核对实际价格、machine ID 和模板镜像；创建返回不确定时只根据本次唯一标签找回原实例，不重发创建。独立本地 watchdog 在付费操作前启动，主流程正常结束后立即停止 VM，只有实际停止确认后才取消 watchdog。实例列表缺失、排队停止、SSH 退出均不能替代停止确认。脚本没有删除实例或启动原模型实例的路径；运行时仍需已有的第二台付费实例授权。

VM 停止前先停止本次 peer，再通过 SSH 获取其完整普通文件 SHA-256 清单和 rsync 快照，逐文件比较后才记录回收完成。含 worker 凭据的快照仅保存在私有目录；遇到链接、目录变化、摘要不符或复制超时，保留 VM 与失败记录，不宣称完整回收。回收单独限时 60 秒，停止预留时间不用于安装或运行 canary。安装与 canary 的输出持续写到本地，异常详情单独保存在私有目录。

8 项 CPU 检查通过：未知/非有限/超限价格拒绝、标签及实例身份核对、禁止操作原模型实例、实际停止状态要求、缺失实例不视作释放、安装包/覆盖包校验、损坏和不安全路径拒绝，以及默认模式不发出任何创建/启停/删除命令。账户状态与云端操作使用 fixture，不代表实际 VM 生命周期通过。

本轮也实际执行了默认只读路径：100 个原安装输入与 13 个覆盖包文件校验通过，Vast 返回候选 `48161398` / machine `23868`，报价约 $0.08954/小时；原模型实例为停止状态。产物位于 `/Users/tangyehui/.codex/artifacts/gear-vast-harbor-execution-preparation-20260909-36`。没有执行 `--run`、创建 VM 或启动 watchdog。后续真实验收仍须核验 VM 的 SSH、Docker、远程模型代理及故障回收，不能用这个执行计划替代 P4 证据。
