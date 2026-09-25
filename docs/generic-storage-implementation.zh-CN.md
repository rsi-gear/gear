# 通用资源存储使用与验证

Gear 与 Hitch 按内容摘要共享不可变输入，为每次执行提供私有工作区。本文说明当前配置、恢复与清理语义，以及已验证的支持范围。

| 能力 | Gear | Hitch |
| --- | --- | --- |
| 普通目录 | clone/copy、预算、复制报告；保留旧 hash/ref | 普通 manifest v1 路径保留 |
| 内容合同 | 共享严格 schema 与固定摘要 fixtures | blob/tree CAS、OCI provider、事务、durable roots/leases、image GC 保护 |
| 执行隔离 | preflight 先于 condition/cell 与 frozen batch；绑定语义 plan | 角色隔离、私有 workspace、实际 tree/镜像证据、两个 producer、显式 legacy export |
| 传输 | JSON selection 单独命名空间，不复制公共输入 | work spec v3、lease 授权流式缺失对象传输、离线 OCI registry bundle |
| 恢复与回收 | 历史 absolute ref 审计、显式 quarantine、owner/generation 释放 | 同锁 mark/sweep、quarantine 重获、unknown 保留、崩溃恢复与预算 |

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

存储升级保留原 ref、dataset digest 和已有评测证据。运行实现身份变化仍按既有组件身份合同处理，不假造旧实现身份以强行复用不可确认的结果，也不自动迁移旧搜索语义。

## 历史验证范围

以下是 2026-09-24 存储交付的验证摘要，不代表此后每个版本都重新执行过实机验收。验证使用合成输入或只读历史输入，没有新增模型调用。

| 范围 | 已验证行为与限制 |
| --- | --- |
| 普通目录 | clone/copy 的相同摘要、独立 inode、双向写隔离；跨设备/不支持回退、短写、取消、损坏输入和预算检查 |
| 并发与恢复 | 三进程物化只发布一个 canonical；pin/freeze 中断、两进程发布/GC、SIGKILL、旧 generation、unknown lease、隔离与重获；未确认的引用保守保留 |
| 历史兼容 | 只读恢复 8 个 round、20 个原 absolute-ref projection、29 个物理评测，273 个原记录文件哈希不变；缺失结果保持 unknown，恢复后可重复复用；未迁移旧搜索语义 |
| 执行与评分 | shared-tree 的资源模式与 legacy export 答案一致、得分均为 1；AutomationBench 同一 snapshot 交叉评分一致，固定 canary 得分为 0，只证明存储和评分等价 |
| 角色与远程协议 | candidate/verifier 私有目录隔离；worker 失联、重建和迟到结果保留资源，错误 epoch/generation 释放被拒绝，确认结束后回收 workspace 并保留 sealed-run root |
| 离线导入 | AutomationBench 首次传输 17,544,214 字节文件对象，重复导入为 0，停止 registry 后仍可执行；该测试未清空原 Docker 层 |
| 空 daemon | 独立 DinD 初始镜像与 BuildKit 为 0，不共享宿主 Docker 缓存；导入后停止 registry、断开外网，shared-tree 答案为 3、得分为 1，重复导入为 0 文件字节 |

### 空间测量

独占 1 GiB XFS reflink 卷上的三个 32 MiB 投影，普通 copy 新增 100,728,832 字节，clone 新增 65,536 字节（约 0.065%）；XFS → tmpfs 的 EXDEV fallback 通过。5 ms 采样所得峰值分别为 101,294,080 和 65,536 字节，短于采样间隔的瞬态可能遗漏。该比例只适用于所测输入与文件系统。

独立 DinD/VFS 的 shared-tree 联合测量包含源输入、离线 bundle、CAS、视图、活动 workspace、staging、保留证据及 Docker 总项。基础设施镜像与输入已包含在基线内；Docker 总项包含镜像、BuildKit、registry volume 和容器写层，只计一次。

| 联合 allocated blocks | 字节 |
| --- | ---: |
| 基线 | 194,494,464 |
| 最高联合采样 | 1,355,063,296 |
| 回收 workspace 后 | 1,087,848,448 |

共 43 次采样，目标间隔 250 ms，实际最大间隔 412 ms；各路径顺序读取，峰值是采样下界。staging 采样为 0 不表示导入未使用临时空间。allocated blocks 不等于 CoW 独占物理字节，也不代表实际释放空间；DinD/VFS 结果不能外推生产 overlay 后端或 100 个任务的节省比例。

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

联合空间核算包含完整输入、CAS、视图、Docker/BuildKit、活动 workspace、临时导入及保留证据，报告同一采样时刻的总量峰值，不把各项不同时间的最高值相加。
