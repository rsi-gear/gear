# Titanic：版本化 Python pipeline 与 Gear 搜索

这是配套 Hitch 改动的**源码示例**。从已下载的 Titanic CSV 生成五个开发折、一个晋升验证任务和一个独立最终训练任务；Gear 只进化 `harness/workflows/titanic/` 中的 Python 和 JSON。DSH Target 通过固定的 `run_pipeline` 工具执行训练，保留真实模型请求与 native session。

实现合同见 [Kaggle spec](../../docs/kaggle-support-spec.zh-CN.md)。当前没有将本目录纳入 npm 发布清单，请使用两个仓库的配套源码构建。

## 环境与版本

| 组件 | 要求或本次实现基线 |
| --- | --- |
| Gear | `05f3cf6d4ba4e03d7e267cbaf1d38fbbc6763782` 加本次改动 |
| Hitch | `f746c03fb0d60983e1acfff9f57554151cfba33f` 加本次改动；`agent-hitch` 0.2.17 源码 |
| 公共协议 | `run_output_artifacts: "1"`、resource manifest v2、`hitch-resource-lock@1` |
| Harbor schema | 0.21.0，源码 `0db8a88cf709c8d6fb88a5a9827c39b515e5cf30`；实际 `TaskConfig` 校验通过 |
| Backend | direct / local Docker；远程产物导出尚不支持 |
| Node / pnpm | Node 22.19+ 的 22.x 或 24+；carrier 固定 pnpm 11.7.0 |
| Target | DSH / dsh-tools 0.1.1-rc.2、Cordis 4.0.1、dsh-codex 0.2.6 |
| Python | Linux Python 3.10+；NumPy 1.26.4、pandas 2.2.3、scikit-learn 1.5.2 |
| 隔离 | root 可信 supervisor、chroot、独立 UID/GID 65532、libseccomp；worker 不联网 |

先在各自仓库执行 `npm ci`、`npm run build`。Hitch 构建结果应支持：

```sh
chmod +x /absolute/agent-hitch/dist/bin/hitch.js
/absolute/agent-hitch/dist/bin/hitch.js capabilities --json
```

源码构建生成的 bin 文件可能没有执行位，重建后需重新赋予；将这个绝对路径填入 `hitch.executable`。也可以使用指向同一配套版本的已安装 CLI。

返回值必须含 `run_output_artifacts: "1"`。旧版 Hitch 仍可运行原有 Gear 任务，但本示例会在准备阶段拒绝缺失该能力的版本。

任务镜像使用 Hitch `benchmark-packages/kaggle/runtime/Dockerfile`：基础镜像须已具备 Node 22+、Python 3.10+ 与 Hitch deepseek adapter 的运行前提。构建和发布后，将**平台 manifest digest** 传给导入器，并按照 Hitch 的 `docs/resource-storage.zh-CN.md` 配置 OCI transport。运行时不安装 Python 依赖。不能把本地镜像 tag 当作不可变镜像身份。

候选容器的可信 DSH 进程需要模型出口；其 Python worker 由 chroot 和 seccomp 约束，仅取得当前 fold 的数据及无凭据的最小环境。私有标签只进入独立 verifier。Meta 的宿主隔离仍须按 [部署指南](../../docs/harness-agnostic-refine-skill.md) 配置；仅隐藏 Skill API 不会阻止一个具有宿主全盘 shell 权限的 Meta 读取数据。

## 准备数据和 Target

自行取得比赛的 `train.csv`、`test.csv`、`gender_submission.csv`，放在独立数据目录。准备命令不下载比赛数据，也不提交预测：

```sh
node examples/kaggle-titanic/prepare.mjs \
  --source /absolute/titanic-csv \
  --out /absolute/new-titanic-project \
  --hitch-repository /absolute/agent-hitch \
  --hitch-root /absolute/hitch-state \
  --base-image registry.example/titanic-runtime@sha256:PLATFORM_MANIFEST \
  --platform linux/amd64 \
  --seed 42 \
  --install
```

`--out` 必须不存在。真实输入要求 891 条训练样本和 418 条 test 样本。`--synthetic` 允许小型合成输入，但标记为 `titanic-synthetic`，不能通过提交入口发送到比赛。

模板包含已验证的 `pnpm-lock.yaml`，直接与传递依赖均随固定 carrier 封存。可选 `--install` 在新的 Target 仓库按 frozen lockfile 安装依赖以便本地验证；省略时，Hitch 的正常制品准备会执行固定依赖安装。缺失已提交的 lockfile 会阻止启动。改变依赖时应重新准备项目，不能在封存后修改固定 carrier。

输出包含 `project.json`、独立 Git `target/` 和 `datasets/{seed,held-out,finalization}`。输入文件 hash、分区 ID、训练 seed、镜像、依赖与 producer revision 被写入 `datasets/competition.json`。源数据与控制面状态不应放入 Meta 可读的工作目录。

## 启动搜索

按 [standalone 配置与 Meta 接入指南](../../docs/harness-agnostic-refine-skill.md) 准备真实的 `base-config.json`，填写 Meta identity、Meta 模型和 Target 模型。`hitch.executable` 必须是绝对路径，凭据仅用现有 `hitch.passEnv` 显式传递。不要用占位 digest 冒充实际 Meta identity。

```sh
node examples/kaggle-titanic/start.mjs \
  --project /absolute/new-titanic-project \
  --config /absolute/base-config.json \
  --prepare-only

node examples/kaggle-titanic/start.mjs \
  --project /absolute/new-titanic-project \
  --config /absolute/base-config.json \
  --rounds 1
```

第一条只验证能力并写入 `gear.config.json`。第二条启动控制面并登记 evolution，打印 `socketPath`、admission 和真实 canonical Meta identity；保持该进程运行，再通过已有 Refine Skill / Meta runner 消费 assignment。它不会自行创建一个假 Meta，也不会在没有模型配置时声称搜索已经完成。停止后恢复既有 evolution 应使用现有控制面恢复接口，重新执行 `start.mjs` 表示登记新 evolution。

目标固定为 `total_score`，约束 `valid_output >= 1`。每个候选和 parent 都使用相同五折比较；process channel 关闭。合法预测的分数等于 accuracy；已确认的候选执行或格式失败为零且无伪造 accuracy，可信执行与评分基础设施故障保持失败。报告的是 mean-fold accuracy，不是 pooled OOF accuracy。promotion holdout 已参与选择，不能称为未接触的最终测试集。

## 选定版本后最终训练

从 Gear 的候选/冠军记录取得明确 commit 和 manifest digest，运行：

```sh
node examples/kaggle-titanic/finalize.mjs \
  --project /absolute/new-titanic-project \
  --commit EXACT_40_HEX_COMMIT \
  --manifest-digest sha256:MANIFEST_DIGEST \
  --out /absolute/titanic-finalization
```

入口验证 Git 源码、固定 carrier 与 manifest，一次性固定所选版本，使用全部有标签训练数据预测官方 test。新 eval 与搜索评分分离，只验证 CSV，不产生 test accuracy。导出的 `submission.csv` 必须与 test ID 集合和两列协议完全一致。

`finalization.json` 在启动任务前记录 eval ID 和输入身份。相同参数重新调用会查询既有 eval、导出并恢复文件，不再训练；输入变化必须换输出目录。只有公共 API 明确报告 eval 尚未存在时，才能用 `--retry-unstarted` 恢复未发出的请求。不要通过删除 journal 来解决超时。

产物通过公开 `hitch runs artifacts list/export` 取得，`artifacts/` 保留 manifest 与受信 receipt。Gear 不读取 Hitch 私有 run 目录。单文件上限 16 MiB，总上限 64 MiB。

## 显式提交（可选）

可以直接在 Kaggle 网页上传 `submission.csv`，也可以配置宿主官方 Kaggle CLI 后显式执行：

```sh
node examples/kaggle-titanic/submit.mjs --finalization /absolute/titanic-finalization
node examples/kaggle-titanic/submit.mjs --finalization /absolute/titanic-finalization --status
```

包装器调用官方 [Kaggle CLI](https://github.com/Kaggle/kaggle-cli) 的提交及 CSV 查询命令，要求查询结果包含 `ref` 和 `description`。在 POST 前保存唯一描述与文件 digest；回复丢失时状态为 unknown，后续调用只查询，不自动重发。默认查询最近一页记录，找不到时保持 unknown，可在 Kaggle 网页核实。不要清空 journal 来触发重发。排行榜分数单独保存，不覆写 CV/held-out 证据。

## 验证

Gear 构建后运行：

```sh
npm run test:kaggle
```

包含公共 manifest 消费、全五折 scope/bridge、carrier checker、finalization 恢复与提交回复丢失测试。公共 CLI 测试使用协议 fixture，不计为真实模型执行。Hitch 侧运行：

```sh
python3 -m unittest discover -s benchmark-packages/kaggle/tests -v
node --test dist/test/kaggle-producer.test.js dist/test/run-output-artifacts.test.js dist/test/eval-output-artifacts.test.js
```

设置 `KAGGLE_HARBOR_PYTHON` 为已安装 Harbor 的 Python 3.12 解释器，可启用真实 `TaskConfig` schema 校验；未设置时该项明确 skip，其他 CAS/评分测试照常运行。

Linux 权限 canary 可在带 Python 与 libseccomp 的测试镜像中运行：

```sh
docker run --rm --user 0 --entrypoint python3 \
  -v /absolute/gear/examples/kaggle-titanic:/example:ro \
  TEST_IMAGE /example/tests/carrier-linux.py
```

它实际验证源码/receipt 写保护、宿主文件与 `/proc` 隔离、凭据环境清理、网络阻止、后代进程清理、一次调用限制及候选失败。这个 canary 不依赖 Kaggle 数据或付费模型。

`tests/carrier-baseline.py --confined` 在安装了固定数值依赖的 root 测试容器内使用实际 runner，对缺失值、未知类别、ID 保留和两次预测一致性做验证。`tests/carrier-native-smoke.mjs` 在已准备 carrier 与合成 Hitch artifact metadata 的容器内启动真实 DSH，通过仅监听 loopback 的测试端点检查模型请求中的工具目录；端点返回明确的 fixture 401，不伪造模型输出或成功轨迹。

本次实际验证（2026-11-04，macOS 宿主、Docker 27.4.0 / Linux arm64、direct 模式）：

| 验证 | 结果 |
| --- | --- |
| Gear 构建、typecheck、Kaggle 专项 | 包含公共产物客户端、启动配置、两个候选及后继继承的真实 workspace/builder 路径 |
| Hitch 原仓库构建、产物/生命周期/producer 专项 | 13 项通过，其中 producer wrapper 执行 9 项 Python 与 4 项 Node 集成测试 |
| Hitch 完整 CLI 测试 | 13 项通过，含本机临时端口测试 |
| 原生 Harbor schema | 7 个任务全部通过实际 0.21.0 `TaskConfig` |
| Linux 权限 canary | 13 项检查通过，包括超时和可信 setup 故障区分 |
| 数值基线 | 固定依赖、真实 chroot/UID/seccomp 内两次训练，预测字节一致 |
| 原生 DSH | Node 22.23.0 + frozen lockfile 启动；仅 `run_pipeline`、参数封闭、固定指令；请求只到 loopback fixture |

本次数值测试镜像 ID 为 `sha256:02ff489e5d50eabc79d452955712e694090a2a692e1ba2baf45a89e11318d551`，原生 DSH 测试镜像 ID 为 `sha256:08e5f3702d83fce4900f9f0fbddfe5e6fab08167197b03e412aeab746701de92`。它们是本机测试镜像身份，不是可直接交给 resource producer 的已发布平台 manifest。

尚未完成带真实模型的五折搜索、晋升、418 行最终训练及外部提交验收。真实验收还需要用户的数据、固定镜像 transport 和模型部署：baseline、至少两个候选、一次后继继承、完整五折、promotion holdout，再对明确选中的 commit 做 finalization。
