# Gear / Hitch 数据集存储膨胀修复规格

状态：待实施。本文只定义修复方案，不代表功能已经实现。  
日期：2026-09-23。  
范围：Gear 的评测任务子集物化，以及 Hitch AutomationBench 适配器的公共运行时打包。

代码核对基线：Gear `f715748dad576d3055e4a9eaab21b36015348aee`；Hitch `20f40cb52c5c2616dff7279d9d2478309c88bd64`。现有未提交修改不属于本规格交付。

## 1. 问题与实测依据

同一套公共源码先按任务重复打包，再按评测子集重复复制。修复应同时减少数据源体积和后续物化成本。

本次清理前的统计如下，单位为十进制 GB；是当时的目录统计，并非当前仍存在的目录，也不能当作独占物理块或可精确回收量：

| 实验 | 原始 dataset | search/datasets | 实验总计 |
| --- | ---: | ---: | ---: |
| marketing-token-20260922-compatible | 3.76 | 15.13 | 19.54 |
| marketing-latest-dsh-20260923 | 3.76 | 3.75 | 8.31 |

- 原始 dataset 有 100 个任务。单任务的 `environment/runtime`、`tests/runtime` 各包含约 18.7 MB 公共运行源码，每份约 580 个文件。
- 较大实验有 15 个任务子集目录，累计 404 份任务目录副本；原始 dataset 和子集副本占实验目录的 96.7%。
- 抽样跨任务、跨 environment/tests、跨评测子集比较文件，内容 SHA-256 相同，但 inode 不同，且不是硬链接。
- Hitch 当前 Dockerfile 先将 upstream 复制到 `/opt/upstream`，随后又 `COPY runtime /runtime`；这会再次带入 upstream，并把任务特有 `task.json` 与大目录放在同一复制步骤中。
- 日志不是此次主要占用来源。仅删日志或只在实验结束后删目录，不能修复新增实验的膨胀。

### 1.1 当前代码位置

| 仓库 | 位置 | 当前行为 |
| --- | --- | --- |
| Gear | [dataset-projection.ts](../src/search/dataset-projection.ts) | 子集 key 为 source digest + 排序后的 task IDs；不同组合递归复制完整任务目录 |
| Gear | [evaluation-adapter.ts](../src/search/evaluation-adapter.ts) | 按待评 cells/repetition 建立子集，冻结 batch 中保存物化后的绝对路径 |
| Gear | [dataset.ts](../src/state/dataset.ts) | tree identity 包含路径、内容、可执行位和空目录，拒绝软链接及特殊文件 |
| Gear | [state/store.ts](../src/state/store.ts)、[search/store.ts](../src/search/store.ts) | evolution 排他锁及依赖 single-writer 的持久状态 |
| Hitch | [AutomationBench import.mjs](../../agent-hitch/benchmark-packages/automationbench/import.mjs) | 每个任务的 environment/tests 各递归复制公共 runtime |
| Hitch | [images](../../agent-hitch/src/images)、[eval-image-resolution.ts](../../agent-hitch/src/control-plane/eval-image-resolution.ts) | 已有镜像摘要、平台校验、构建缓存、锁、pin 和镜像 GC |
| Hitch | [task resources](../../agent-hitch/integrations/harbor/hitch_harbor_task_resources.py) | Compose build、独立 verifier build 仍可能走 backend-build |

必须保留两个区别：完全相同的任务组合目前已经复用；不同但重叠的组合没有按任务去重。Gear 的实际任务身份来自完整 tree hash，不能用 adapter 声明的 `task_digest` 直接替代。

## 2. 决策与交付顺序

| 阶段 | 负责人 | 交付 |
| --- | --- | --- |
| G1，优先 | Gear | 显式 CoW 物化、可观测 fallback、完整性校验和原子发布；保持现有目录及身份兼容 |
| H1 | Hitch | AutomationBench v5 的共享镜像布局；普通任务目录只携带小型配置、输入和启动文件 |
| G2 | Gear | 存储统计、预算限制、显式的未引用临时数据清理；保留所有持久引用 |
| H2 | Hitch | 离线镜像交付与 cache-only 解析；满足离线及远程验收后，再考虑将新布局设为默认 |

G1 可独立发布；它在支持 CoW 的文件系统上降低投影新增物理占用。H1 降低数据集本身体积，在普通复制的文件系统上同样有效。

本轮不引入跨仓库通用 CAS、不更改 Harbor 任务子集协议、不自动改写历史实验、不把 chmod 后的普通硬链接当作写入隔离。真正的跨组合 task-CAS、旧实验 compaction/rehydration 可另立后续规格，不能作为 G1 的前置条件。

## 3. 必须保持的约束

1. Gear G1 生成的目录路径、文件字节、可执行位、空目录、manifest 字节、返回 `{ ref, digest }` 与旧实现一致。
2. Gear 不改变任务选择、评分、cell identity、condition identity、已冻结的 submission intent，不能因此多跑一次模型评测。
3. 不给已封存实验换数据集、不覆盖损坏的投影、不修改原始数据集以适配缓存。
4. 任意两份可写物化结果不得通过共享 inode 串改。修改源或任一副本不得改变其余副本。
5. 继续拒绝检测到的软链接、FIFO、设备等特殊文件；检测到源路径替换、链接变化或内容变化时不得发布。G1 的路径版 Node API 以源目录可信且在物化期间停写为前提，不提供对同权限恶意进程的文件系统隔离保证，见 §4.2。
6. Hitch 候选环境只获得现有工具客户端与 schema；共享运行时中的上游源码、模拟器和 verifier 不能因此暴露给候选环境。
7. 实验来源、轨迹、verifier、Git 历史和共享证据存储不属于本规格的自动回收对象。

## 4. Gear G1：保持身份兼容的 CoW 物化

### 4.1 内部接口

新增内部文件树物化模块，例如 `src/state/materialize-tree.ts`。`projectDataset` 对外仍返回 `{ ref, digest }`；统计通过单独 report 返回给调用层或写入 sidecar。

内部调用链新增 `AbortSignal` 和已持有的 evolution lock context；从 `EvaluationSearchAdapter.batches` 向下传递。不可因返回值兼容就省略取消和锁的输入合同。

```ts
type CopyMode = 'auto' | 'require-clone' | 'copy'

interface MaterializationPolicy {
  mode: CopyMode                 // 默认 auto
  maxFallbackBytes?: number     // 本次物化允许普通复制的逻辑字节上限
  minFreeBytes?: number          // 目的文件系统需要保留的最低可用空间
}

interface MaterializationReport {
  schemaVersion: 1
  clonedFiles: number
  clonedLogicalBytes: number
  copiedFiles: number
  copiedLogicalBytes: number
  fallbackReasons: Record<string, number>
  elapsedMs: number
}
```

以上名称为拟新增接口。策略属于宿主存储配置，不能写进被哈希的数据集、评分配置或历史 `EvolutionSpec`；它改变存储方式，不改变实验内容。新增配置必须经过现有配置解析和校验，不能只读未声明的环境变量。

### 4.2 文件复制规则

- `auto`：逐个普通文件尝试 `copyFile(src, dst, COPYFILE_FICLONE_FORCE | COPYFILE_EXCL)`；成功计入 clone，只有确认不支持 clone 或跨设备时才普通复制。
- `require-clone`：任何不支持 clone 的文件都使本次物化失败；保留既有 canonical 和源目录。
- `copy`：显式普通复制，用于兼容性测试、故障排查和不支持 CoW 的环境。
- 不能用普通 `COPYFILE_FICLONE` 的成功返回证明发生了 clone，因为该 API 允许自动回退。此区别依据 [Node.js copyFile 文档](https://nodejs.org/api/fs.html#fspromisescopyfilesrc-dest-mode)。
- fallback 只接受经过平台测试的明确原因，例如 `EXDEV`、`ENOTSUP`、`EOPNOTSUPP`、`ENOSYS`。权限错误、`ENOSPC`、I/O 错误、源内容变化、目的文件已存在都直接失败。不能把所有 `EINVAL` 当作平台不支持。
- 复制保留可执行位和目录结构。不得对源文件 chmod，不创建普通硬链接。CoW 支持必须实际探测，不能仅根据“macOS/APFS”或文件系统名称假定支持。
- 路径版 `copyFile` 与前后 `lstat/realpath` 不能彻底消除检查到使用间的竞态。G1 在可信、停写的源目录上使用前后路径/文件身份检查和最终 tree 校验，拒绝检测到的链接或源变更；不得宣传这些检查能阻止同权限攻击者在竞态期间诱导根外读取。需要处理不可信并发写入源时，必须先通过独立安全导入冻结源，或另实现基于受控目录句柄/no-follow 的平台原语，不能悄悄扩大 G1 的保证。
- 复制并发有上限；不要一次打开整个任务集的全部文件。
- 普通复制前检查 fallback 预算及可用空间。预算以最坏新增复制字节计，不提前假定后续文件一定可 clone；`statfs` 只做预检，真实写入仍需处理 `ENOSPC` 并清理本次临时文件。

### 4.3 生成、验证、发布

1. 保持原 subset key 和 canonical 路径不变：`search/datasets/<hash(sourceDigest, sortedTaskIds)>`。
2. 首先区分 canonical 根目录不存在与已存在但内部缺文件。后者视为损坏，不能因内部 `ENOENT` 自动重新构建或覆盖。
3. 已存在时执行原有 task digest、manifest 和根目录精确 entries 校验后复用。
4. 新建时只写同一父目录下属于本调用的 UUID temp；复制任务并生成原格式 manifest。
5. 校验 temp 内每个任务、manifest、entries 和完整树摘要，再复核源数据集未变化，才允许原子发布。
6. 所有 producer 必须遵守同一 evolution 排他锁，并在发布前、持锁期间重新检查 canonical。目标一旦存在就完整验证；空目录也属于损坏现场，不覆盖。普通 `rename` 可能替换已存在的空目录，所以“不覆盖”依赖全体 producer/GC 的锁合同，不能只依赖 `EEXIST/ENOTEMPTY`。若仍遇这两种错误，仅在验证 winner 与预期一致后复用；其他错误传播。未来若允许无锁 producer，必须先采用真正的 no-replace 发布机制。
7. 取消后停止调度新文件，等待全部在途 `copyFile` 完成或失败，再清理本调用拥有的 temp；`copyFile` 本身不能直接通过 signal 中断。发布前、冻结 batch 前分别再次检查 signal。若发布成功后才取消，保留完整但未引用的 canonical，交给 G2 按锁与引用规则处理，不启动评测。出错、预算不足也必须等待在途写入收敛后清理，不能边删 temp 边让 worker 继续写。
8. 不同时引入持久 tree-hash 缓存；保留当前跨调用的篡改检测。后续缓存优化必须另证实不会因 mtime、文件替换或原地修改漏检。

物化报告放在 `search/materializations/<subset-key>.json` 等 dataset 树之外。缺少 sidecar 的历史投影仍能验证和使用；sidecar 不是数据完整性的权威来源。

### 4.4 并发与恢复

沿用现有 evolution/round 排他锁及 single-writer 合同。所有正式入口和直接测试调用都必须取得并传入可验证的 lock context；GC 使用同一把锁。物化、canonical 发布到 frozen batch 引用落盘必须都在锁范围内，不得在这段间隙让 GC 进入。并发测试运行两个遵守该合同的进程，而不是给两个无锁调用赋予并不存在的安全保证。

恢复已有 batch 时继续使用原 absolute ref。失败恢复、unknown reservation、已完成结果复用都不允许因存储方式改变而重新提交模型任务。若后续开放不经过 service 锁的独立 materializer/GC API，必须显式传入锁或 lease，不能暗自依赖调用顺序。

## 5. Hitch H1：把公共 runtime 从任务副本中移走

### 5.1 新版本和布局

新增 AutomationBench adapter v5 的 `shared-image` 布局；保留 legacy 布局入口。H1 先显式选择新布局，完成 H2 之前不默认改变离线用户的导入行为。

任务仍是普通、独立的 Harbor task 目录，不引用宿主上的 `../../runtime`，也不需要 Gear 识别 AutomationBench 专用字段。示意布局：

```text
dataset/
  benchmark.adapter.json
  source-manifest.json
  runtime-build-recipe/              # 整个包至多一份，用于来源审计/重建
  marketing-<task>/
    instruction.md
    source-prompt.json
    task.toml
    runtime-image.lock.json          # 很小，绑定公共镜像身份
    environment/
      docker-compose.yaml
      candidate/                    # 只有客户端和 tools schema；不含 verifier
        Dockerfile
        call.py
        tools.json
      simulator/
        Dockerfile                  # FROM runtime@sha256:...
        task.json
    tests/
      Dockerfile                    # FROM 同一个 runtime@sha256:...
      task.json
      test.sh
```

Compose 的两个 build context 都必须限制在当前 task 内；candidate context 不含 simulator 的 task.json，防止同一客户端因整目录 hash 不同而重复构建。现有消费者如对路径布局有假设，应在 adapter、资源发现和 loader 处同时兼容，不改变 Harbor 协议。

任务目录对本地文件保持自包含；公共镜像是明确固定摘要的环境依赖。单独复制任务目录到新机器时，需要可获取该镜像或携带经过验证的离线镜像包，不能声称只复制目录就支持无网络运行。

### 5.2 公共镜像内容及构建身份

公共 runtime 镜像只构建一次，包含上游固定 commit、锁定的 Python 依赖、模拟器和 verifier 脚本。每个 simulator/verifier 子镜像只增加 task.json、test.sh 等小文件。

- upstream 只放在 `/opt/upstream` 一处。用显式文件清单复制 adapter runtime 脚本，禁止再次 `COPY runtime /runtime` 把 upstream 和任务数据整体带入。
- 公共层禁止包含 task.json、当前任务输入、运行结果、凭据、日志或任务专属状态。
- 候选环境使用原来的最小 Python/客户端环境，不继承公共 verifier runtime。
- 只共享不可变镜像层，不共享可写容器、simulator world、snapshot、输出或临时目录；每个 trial、角色和并行任务继续各自隔离。
- 第一版不按领域裁剪上游 Python 包；减少重复比猜测跨模块依赖更可靠。
- 新 `runtimeRecipeDigest` 必须覆盖全部参与构建的文件、其可执行位、上游 commit、依赖锁、基础镜像 digest、平台、构建参数和 Dockerfile。不能继续只用 Dockerfile、ref、official.py、export.py 作为缓存身份，遗漏 server.py 等内容。
- 区分 recipe digest、OCI manifest digest、image config digest。最终 Dockerfile 使用 `repository@sha256:<manifest>`；可变 tag 不是执行身份。[Docker 的 digest pinning 说明](https://docs.docker.com/build/building/best-practices/#pin-base-image-versions)。
- adapter 保持独立源适配器，不直接 import Hitch 私有实现。可新增 `build-runtime.mjs` 等独立构建入口；镜像发布到 registry 必须是显式操作，导入不能偷偷推送用户环境。

每个任务的 `runtime-image.lock.json` 拟包含：

```json
{
  "schema_version": "1",
  "kind": "automationbench-runtime-image",
  "source_commit": "<完整上游 commit>",
  "adapter_content_digest": "sha256:<全部 adapter runtime 内容>",
  "dependency_lock_digest": "sha256:<依赖锁内容>",
  "runtime_recipe_digest": "sha256:<完整构建输入>",
  "image": {
    "reference": "<registry/repository>@sha256:<OCI manifest>",
    "manifest_digest": "sha256:<OCI manifest>",
    "platform": "linux/amd64"
  },
  "roles": ["simulator", "verifier"]
}
```

这是新 adapter 的文件合同，需实现严格解析和一致性校验；不能只生成一个无人校验的说明文件。Dockerfile/Compose、lock、实际使用的镜像及平台必须一致。所有字节均进入任务树身份；不能仅修改顶层 `source-manifest.json` 记录镜像而让被 Gear 投影的 task 丢失绑定。

现有 `benchmark.adapter.json` 使用严格键校验。本方案不往 v1 manifest 偷加 runtime 字段，不新增 Gear ↔ Hitch 协议；新信息放在 task 普通文件和已支持的环境镜像证据中。adapter revision、task digest、dataset digest 因布局和导入器内容变化而更新，这是新数据集，不是旧数据集的透明替代品。

### 5.3 镜像复用和调度

- 接入 Hitch 既有 `src/images` 所有权域、平台/摘要校验和执行证据；不把 benchmark runtime 塞入面向 harness 的 prepared-artifact store。
- 同一次准入中，同一 `(immutable reference, platform)` 只解析/拉取一次，再供多任务和两个角色复用；不能每个 task 各做一次相同 pull。
- 公共 runtime 层只能有一份内容；允许任务特有的小层和标签。验收同时统计 Docker/BuildKit 占用，不能把宿主重复文件迁移成 N 份 Docker 大层后宣称修复。
- 保留运行环境与 verifier 的观测绑定。镜像不可用或不匹配必须在评测执行前明确失败，不能回退成可变 tag 或另一版 runtime。
- H1 必须新增 `runtime-image.lock.json` 的严格 loader，并在准入前发现 Compose simulator 和独立 verifier Dockerfile 的固定摘要 base；核对 lock、Dockerfile、角色及平台一致，把公共依赖纳入镜像解析、持久引用保护和实际执行证据。仅生成 importer 输出不算 H1 完成。
- 当前资源发现对 Compose build 只报告 backend-build，不能据此认为它已经发现共享 runtime。H1 必须补齐上述依赖发现及校验链路；对于仍未实现的整套 `prebuild-required` 执行路径继续明确拒绝，不能静默降级或绕开已有策略。

## 6. Hitch H2：离线和远程交付

当前 `DockerRegistryResolver.resolve` 会执行 pull，不具备完整的 cache-only/offline 语义。以下是新增工作，不能当作现成功能：

1. 增加显式的缓存优先/仅缓存解析策略；已存在的本地镜像仍须核对 manifest、config、平台和内容来源，不接受仅 tag 命中。
2. 离线 bundle 对同一镜像及其 blobs 按 digest 去重，只携带一次，并包含文件摘要清单、runtime lock 与构建来源。布局将 `dataset/` 与 `images/` 分开，镜像 archive 不放入被 Gear 反复哈希或投影的 dataset/task 树；远端也不得将镜像 archive 逐任务塞入 JSON work envelope。排除凭据和任务运行日志。
3. 接收端先验证 bundle 和镜像，再准入任务；并发导入使用已有锁机制，失败不得留下被误认为完成的索引。
4. 镜像 load 后是否能直接通过 `FROM repository@digest` 被实际 builder 解析，必须用当前 Docker/BuildKit 路径实测。不得把 Docker config ID 当成 registry manifest digest，也不能假定 OCI archive load 自动恢复全部 RepoDigests。
5. 若后端不能恢复固定摘要引用，则显式报不支持，或采用已验证、记录身份的本地解析机制；禁止换成未校验的临时 tag。H2 未通过之前，离线用户继续选 legacy 完整包。
6. 远程工作机从 bundle 或固定摘要 registry 获得全部环境依赖；不依赖发送端 `.evolve-lab` 路径，也不依赖发送端 Docker 缓存恰好存在。

H1 的 registry 模式可以先发布为 opt-in。只有固定摘要路径、断网运行、远程交付、重新评分均通过验收，才能将 shared-image 作为默认推荐布局。

## 7. Gear G2 与 Hitch 回收边界

### 7.1 Gear

新增显式 storage inspect / cleanup 能力；命令或 API 名称在实现时接入现有 CLI，不把本文示意当成已存在命令。cleanup 默认生成计划，执行模式必须显式指定。

首版只能清理：

- 有明确 Gear 所有权、owner 已结束且超过 grace 的未发布 temp。
- 没有任何 durable frozen batch/source/result 引用、没有进行中的 producer 的已验证孤立 projection。

引用扫描、owner 检查到 quarantine rename 必须持有同一 evolution 锁；成功隔离后再删除。引用记录缺失、损坏或解析失败时保守保留并报告，不能据此判定无引用。

所有 frozen inputs 指向的 projection 都保留，包括 complete、failed、reserving、started、unknown 和 recovering。当前恢复会直接使用保存的绝对路径；terminal 状态、很老的 mtime、宿主 PID 退出都不是删除依据。尤其不能把宿主退出等同于远程评测结束。

既有历史投影的垃圾回收按引用扫描，不要求先存在新 sidecar。只读缓存删除仅可调整已验证、待删除且属于当前操作的目录权限，不 chmod 源数据或保留证据，也不跟随软链接。

### 7.2 Hitch

沿用现有 image pin、active eval、sealed bundle 和构建锁保护。核对共享 runtime 的依赖引用能被保护；不能新建一个不参加既有生命周期管理的隐藏镜像缓存。

当前镜像 GC 对外部 registry 镜像保守保留，这一行为不在本修复中改成自动清除。共享 runtime 的 release 是显式运维动作；不得执行全局 `docker system prune` 来实现实验清理。

新增的离线 archive 缓存要单独记录所有权、bundle/pin 引用、活跃导入和删除范围；现有 image GC 不负责普通 archive 文件。独立 producer 的 `hitch-source-adapter:*` 镜像也不会因名称前缀自动变成 Hitch managed image，必须明确登记或继续按外部镜像保守保留。

实验来源和长期保留策略必须用显式 pin/保留清单表达。不能跨 Gear/Hitch 边界根据目录名字自动删除 `.dsh`、`.hitch`、Git worktree 或原始轨迹。

## 8. 兼容、迁移与回滚

- Gear G1 对旧实验只读复用已有 canonical；不会自动重写旧副本。因此升级本身不承诺立即释放已占空间。
- 若未来提供旧投影 clone-compaction，必须在停写、持锁和显式选择后执行；保持原路径及全部摘要，准备失败可回滚，不能覆盖已冻结记录。该能力不阻塞本轮交付。
- Hitch v5 在新输出目录导入，并产生新的 adapter/task/dataset identity。旧 v4 包、旧 admission 和旧证据继续使用原版路径；不自动搬移、重封存或跨新旧数据集复用 cell。
- adapter importer 的源码本身进入现有输出，所以即使只改变导入过程，也不能盲目承诺 Hitch 输出 digest 与旧版完全相同。
- 回滚 Gear 时保留普通目录合同，旧代码应仍能读取 G1 生成的投影。回滚 Hitch 时使用原 legacy 包或重新按 legacy 版本导入；不可把 shared-image 的新摘要伪装成旧摘要。
- 当前用户保留的初始迭代、GEPA、两批 Luna Max，以及 `.evolve-lab/KEEP_EXPERIMENTS.md` 记录的外部依赖，只读作为历史核验来源；开发和压力测试不得使用这些目录作为清理目标。

## 9. 可观测性和容量指标

至少输出：源任务逻辑字节、投影逻辑字节、clone 成功文件/字节、实际普通复制文件/字节、fallback 原因、物化耗时、image pull/build 次数、公共 runtime 唯一 digest 数、GC 保留原因与删除计划。

`clonedLogicalBytes` 不等于实际释放或节省字节。CoW 后文件逻辑大小、`du` 或各文件 `st_blocks` 相加仍可能显示副本大小；不得据此宣称 clone 失败或报告精确独占空间。物理占用验收在隔离文件系统/测试卷上测量 `statfs` 前后变化，并报告测量条件及误差。

将宿主文件、Docker 镜像层、BuildKit cache 分别统计；不能重复计数，也不能漏掉镜像端增长。

## 10. 验收标准

### 10.1 Gear 正确性

| 场景 | 必须结果 |
| --- | --- |
| 原 copy、强制 clone、普通 fallback 的同一 fixture | manifest 字节、task/tree digest、subset key、返回 ref/digest、condition 完全相同 |
| 改写 source、projection A 或 B | 其余两者字节不变；原有篡改校验仍能发现被改写对象 |
| executable、空目录、软链接、特殊文件 | 保留前两者；明确拒绝后两者 |
| 两个持锁进程请求同 subset | 一个有效 canonical，双方返回同一身份，不覆盖 winner，无遗留自有 temp |
| 发布前发现空 canonical | 视为损坏现场并失败，不能被 rename 替换 |
| copy 中断、ENOSPC、写 manifest 失败、源内容变化、发布前崩溃 | canonical 不出现或完整有效；不冻结错误 batch，不启动评测 |
| 复制中取消、发布后冻结前取消 | 停止新调度并等待在途写入；前者清自有 temp，后者留下完整未引用投影；均不启动评测 |
| canonical 内部缺文件或 manifest 损坏 | 报错并保留现场，不静默覆盖 |
| unsupported clone、跨设备 | auto 可受预算约束 fallback；require-clone 失败；统计准确 |
| permission/I/O 错误 | 不伪装成 clone 不支持 |
| 旧 batch 重启、unknown reservation、已完成结果重用 | 原 ref 可验证，不新增评测执行 |
| GC 与 publish/freeze 竞争 | 未完成冻结的 producer 受锁保护；任何 durable 引用均不会被删 |

现有相关套件包括 `tests/unit/search-evaluation-adapter.spec.ts`、`dataset-identity.spec.ts`、`hitch-cli-evaluator.spec.ts` 及 state/search recovery 测试。新增测试应覆盖上述行为，不只 mock 一次 cp 调用。

### 10.2 Hitch 正确性

- v5 与 legacy 对固定任务输入导出的 task contract、工具 schema、提示词和评分规则等价；使用固定行动轨迹/最终状态比较 verifier 输出，不要求随机模型跑分逐项相同。
- 修改任一 adapter runtime 文件、依赖锁、平台或基础镜像，都改变正确的 recipe/环境身份；旧缓存不可误命中。
- 同一公共 runtime 在 100 任务中只解析/准备一次；每题 environment/tests 不含完整 upstream 副本，公共镜像中 upstream 仅一份。
- 不同 task.json 的变化只进入小型任务层，公共 runtime digest 不变；candidate 环境无法读取 verifier/runtime 私有实现。
- registry、cache-only、断网 bundle、新机器/远端执行分别测试；摘要不符、错误平台、缺镜像在准入阶段失败。
- 实际准入链路测试 lock 与 Dockerfile 不一致、缺失 shared base、锁记录未知字段，以及 active eval 期间 GC；不能只用 importer 单元测试替代 loader/执行/保留链路。
- 保留任务目录移动后的可用性；完整运行结果仍记录实际镜像与 verifier 身份，重评分不依赖原发送端路径。
- GC 不能删除 active eval、pin 或 sealed evidence 依赖的镜像；并发 build/load 与 GC 不冲突。

### 10.3 空间验收

1. Gear 使用可重复的固定数据集和重叠子集 benchmark，分别运行 copy、clone、fallback。CoW 测试卷上，创建与基线相同投影集合的新增物理字节目标不超过 copy 模式的 20%；逻辑字节仍相同。此指标是发布门槛，需要实测，不是当前已经取得的结果。
2. 不支持 CoW 的文件系统不承诺 Gear 单独节省空间；必须正确报告 fallback 和预算失败。
3. Hitch 固定 100 个 Marketing 任务，shared-image 布局的宿主 task 树合计目标不超过 200 MB；runtime 构建来源和镜像按唯一 digest 另计一次。不得通过省略任务输入、source provenance、schema 或 verifier 所需数据达标。
4. 100 个任务的共享镜像磁盘增长应为一份公共 runtime 加任务小层；相较当前逐任务大层实现，宿主 + Docker/BuildKit 的受控总增量目标至少降低 80%。测量应排除两组共有的预先存在基础镜像，并公开逐项计数；若不达标，H1 不视为完成。
5. 使用合成 fixture 和新临时目录验收，不重建已经删除的旧实验，不为验证存储优化重新调用付费模型。

## 11. 建议拆分 PR

| PR | 内容 | 合入门槛 |
| --- | --- | --- |
| Gear-1 | materialize-tree、显式 clone/fallback、原子发布、并发 winner 校验 | 身份兼容、隔离、错误恢复与平台矩阵通过 |
| Hitch-1 | v5 shared-image importer、完整 recipe identity、瘦 task context、角色隔离 | registry 路径、标准任务兼容、评分等价和镜像层去重通过；先 opt-in |
| Gear-2 | sidecar 统计、预算、显式 inspect/cleanup 与保守引用保护 | 运行/恢复/GC 竞争测试通过，历史引用零误删 |
| Hitch-2 | cache-only resolver、去重离线 bundle、远程预载与镜像证据 | 断网、新主机、平台不符和重新评分测试通过 |

各 PR 应在各自仓库中实现；本文作为跨仓库接口和验收的统一依据。不要把“已申请 clone”“导出包更小”或“清理后有空闲空间”单独当作整个问题已经修复的证据。
