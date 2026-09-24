# 通用资源存储实施与验收

对应 2026-09-24 更新的 `gear-hitch-generic-storage-spec.zh-CN.md`，P0–P4 已实施并完成所列首版能力的验收。设计文档保留原文；本文件记录实际入口和已有验证。逐项完成状态以 [完成审计](generic-storage-completion-audit.zh-CN.md) 为准。

| 阶段 | Gear | Hitch |
| --- | --- | --- |
| P0 | 普通目录 G1 clone/copy、预算、复制报告；保留旧 hash/ref | 普通 manifest v1 路径保留 |
| P1 | 共享严格 schema 与固定摘要 fixtures | blob/tree CAS、OCI provider、事务、durable roots/leases、image GC 保护 |
| P2 | preflight 先于 condition/cell 与 frozen batch；绑定语义 plan | 角色隔离、私有 workspace、实际 tree/镜像证据、两个 producer、显式 legacy export |
| P3 | JSON selection 单独命名空间，不复制公共输入 | work spec v3、lease 授权流式缺失对象传输、离线 OCI registry bundle |
| P4 | 历史 absolute ref 审计、显式 quarantine、owner/generation 释放 | 同锁 mark/sweep、quarantine 重获、unknown 保留、崩溃恢复与预算 |

## 使用

普通数据集默认 `datasetStorage: {"mode":"auto"}`。可在 Gear 配置中指定：

```json
{"datasetStorage":{"mode":"copy","maxFallbackBytes":8589934592,"minFreeBytes":67108864}}
```

`require-clone` 在平台不支持时失败；`auto` 只在 `ENOSYS/ENOTSUP/EOPNOTSUPP/EXDEV` 回退。权限、I/O、空间和损坏错误不会被当作“不支持克隆”。源须受控且静止，目标必须由当前操作拥有。报告在 `search/materializations`，不进入数据集 hash。

显式 copy 和普通 fallback 使用最多 1 MiB 的读写缓冲，处理短写并在取消后关闭句柄；避免 Linux `copy_file_range` 在 copy 对照中隐式共享块。

投影发布先原子写入完整 ownership sidecar，再重命名正式目录；报告失败时不会发布无所有权证明的投影。报告已完成而目录尚未发布的中断状态可以重新物化，统计来自重试的实际复制过程。复用既有无 sidecar 的投影不会自动补造所有权证明。

v2 数据集由 Hitch producer 封存，Gear evaluator 必须实现 `resourcePreflight`；Hitch CLI adapter 已实现。Gear 使用公共 schema/摘要合同，不导入 Hitch 私有运行时。能力、对象、平台或计划不匹配时，在预约评测和冻结前失败。`search/selections/<digest>.json` 保存所选任务描述与资源 roots；普通目录仍使用 `search/datasets/<digest>`，不会将 JSON 冒充旧目录。

`search/resource-retention/{seed,held-out}.json` 保存已确认 pin 的 owner/generation。Hitch pin 先完成，Gear 才发布 frozen 指针。取消和崩溃允许多保留引用；已经冻结的历史不因 complete/failed 自动释放。

```sh
gear-refine storage inspect --state-root /absolute/evolution
gear-refine storage cleanup --state-root /absolute/evolution
gear-refine storage cleanup --state-root /absolute/evolution --apply
gear-refine storage release-resources --state-root /absolute/evolution --hitch-root /absolute/hitch --partition seed
```

cleanup 默认 dry-run，`--apply` 先隔离，后续经过宽限期再确认无引用后删除。缺失/损坏历史会停止清理；unknown 与旧 absolute refs 一样受到保护。没有本实现 ownership sidecar 的历史投影、未知临时目录和 selection 默认保留。资源释放先在 Gear 锁内核查完整历史并写入 releasing，再逐个调用 Hitch 的 generation checked release；中断后原 generation 可幂等重试。released owner 不用于新 evolution。

隔离记录与目录移动之间的中断由投影重获和 cleanup 共用的校验逻辑处理：仅当正式目录完整匹配记录摘要、隔离树不存在时，才允许在锁内清除残留记录。dry-run 不修改记录；已有历史引用继续保留正式目录，无引用投影重新隔离并重新计算宽限期。两份树并存、树丢失、摘要不符或隔离目录含未知文件时停止清理。删除记录后留下的空隔离目录可安全重试。

此实现没有删除、迁移或重新评测 `.evolve-lab` 中的实验。运行实现身份变化仍按既有组件身份合同处理，不假造旧实现身份以强行复用不可确认的结果；原 ref、dataset digest 和已有评测证据保留。

## 验收结果

最终验证使用 Node 26.7.0：Gear 全量测试加 notebook 的正确 Python 环境复验，去重后 1,159 项通过、4 跳过；Hitch 资源、镜像与远程相关 144 项全部通过。两仓库类型检查、Hitch 干净构建/架构/语法检查及 npm 打包清单检查通过。具体命令范围与环境复验原因见 [完成审计](generic-storage-completion-audit.zh-CN.md)。

Hitch 原有 DeepSeek 冷构建 Docker 集成测试曾受 `auth.docker.io` DNS 超时阻塞。后续仅为测试进程设置可用的本机 HTTP(S) 代理后，原测试在 40.4 秒内通过，覆盖首次构建、缓存复用和不含 pnpm 的真实任务容器执行；未修改代码、断言或超时。完整套件加该单项复跑去重后为 843 通过、7 跳过、0 个未解决失败，详见 [继续验证记录](evidence/generic-storage/continued-validation.json)。其余首次全量运行发现的接口清单与 bundle readiness 问题已分别修正或隔离复验通过。

- 命名旧实验只读恢复：8 个 round、20 个原 absolute-ref projection、29 个物理评测；两组 Luna Max 保持 50/100 和 53/100，原 273 个记录文件未变，没有模型调用。见 [历史实证](evidence/generic-storage/historical-recovery.zh-CN.md)。
- Gear 单元覆盖 clone 成功路径、跨设备/不支持回退、写隔离、损坏 canonical、取消、预算、冻结前 preflight、selection、恢复时计划变化、历史引用与释放中断。
- `scripts/canary-dataset-storage.mjs` 在正式 build 上启动三个进程：重复投影只发布一个 canonical，重叠投影和源的写入互不影响。
- Hitch 覆盖两进程发布/GC、首个对象发布后 SIGKILL、旧 generation、unknown lease、镜像 GC fence、view 与 CAS quarantine 重获、远程授权、流式去重和离线索引/内容损坏。
- shared-tree terminal 真实 Docker 运行：资源模式与 legacy export 答案一致，均得 1 分。
- AutomationBench 从原 v4 只读导入共享 runtime。真实运行 candidate 隔离检查、simulator API 与官方 verifier；资源/旧格式的 tool 结果、断言和评分一致，同一 snapshot 交叉评分一致。固定 canary 只调用 API search，评分为 0；它验证存储与评分等价，不声称完成业务任务。三个角色的实际 image config、平台和 base layers 入证据。
- 离线测试从空文件 CAS、空本地目标 registry、缺失目标镜像引用开始，传输 17,544,214 字节文件对象；重复导入 0 字节。关闭源和目标 registry 后仍完成 AutomationBench 执行和交叉评分。Docker daemon 的已有其他层未清空，不能将此描述为“清空用户整台机器”。
- 新增独立 DinD 空 daemon 实测：初始镜像及 BuildKit 为 0；导入完成后停止 registry、断开外网，shared-tree 实际答案 3、评分 1，重复导入 0 文件字节。未共享宿主 Docker 层，未清空用户缓存。原始阶段空间记录见 `evidence/generic-storage/empty-daemon.json`。
- 本机 macOS/Node 强制 FICLONE 返回 `ENOSYS`；另在独占 1 GiB XFS 测试卷实测三个 32 MiB 投影，copy 新增 100,728,832 字节、clone 65,536 字节，比例 0.065%，满足原 G1 20% 门槛。XFS → tmpfs 实测 EXDEV fallback；独立 inode、相同摘要和双向写隔离通过。采样峰值与测量条件见 `evidence/generic-storage/xfs-clone.json`。

复现命令：

```sh
npm run build
node scripts/canary-dataset-storage.mjs
node scripts/canary-clone-filesystem.mjs
node scripts/canary-historical-storage.mjs /absolute/gear /absolute/agent-hitch
npx vitest run tests/unit/dataset-materialization.spec.ts tests/unit/resource-contract.spec.ts tests/unit/search-evaluation-adapter.spec.ts tests/unit/hitch-cli-evaluator.spec.ts
```

Hitch 操作合同与 producer 说明位于另一仓库的 `docs/resource-storage.zh-CN.md`、`benchmark-packages/shared-tree/README.md` 和 `benchmark-packages/automationbench/RESOURCES.md`。

## 明确的首版边界

启用的后端为 `harbor-role-context@1`：普通 private-copy/CoW、分角色 build contexts、固定平台 OCI build-base。只读 bindings、OCI index membership、任意挂载、Package-native phase 与 resource-aware 远程 verifier-only 请求在准入时拒绝。普通协议原有执行能力保持原范围。

OCI manifest proof 首次由在线准入或完整离线包取得。Docker `save/load` 的 RepoDigest 丢失已实测；可移植离线包保存原始 registry 字节，目标显式配置 loopback registry，以原摘要恢复，不用 tag 替代。公开/匿名 Bearer registry 可导出；私有 registry 认证需要后续 provider 能力。

导入及首次在线 pull 前验证展开 layer 的字节数、条目数、tar 路径和 config diff IDs；首版支持 gzip/普通 tar。稀疏文件、未知压缩格式及未经验证的 docker-archive 明确拒绝。压缩 staging 与展开预算分别受限；不在宿主提取 tar 条目。

空间统计分开记录逻辑字节、clone/copy、传输与 allocated blocks；CoW blocks 可能重叠。OCI/BuildKit、保留结果和源目录属于独立占用，未承诺整机只有一份，也未把 `du` 总和当作独占物理节省。

联合空间验收见 [报告与测量限制](evidence/generic-storage/joint-space.zh-CN.md)：包含完整输入、CAS、视图、Docker/BuildKit、活动 workspace、临时导入及保留证据，报告同一采样时刻的总量峰值，不把各项不同时间的最高值相加。
