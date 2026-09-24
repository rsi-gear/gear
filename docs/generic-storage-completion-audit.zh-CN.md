# 通用资源存储完成审计

审计基准：2026-09-24 版 `gear-hitch-generic-storage-spec.zh-CN.md`，交付范围为 P0–P4。实现和下列首版能力的验收已完成；每项结论对应具体实证，并保留测量精度与后端能力边界。原设计文档不改写，当前状态以本文为准。

## 逐项验收

| spec 要求 | 当前证据 | 判断 |
| --- | --- | --- |
| §10.1 三个重叠 selection、独立 owner、CAS 去重 | Hitch `resource-execution.test.ts` 三个重叠子集；`resource-recovery.test.ts` 两个发布进程与 GC 竞争、释放一个 owner 后验证另一个闭包 | 已验证 |
| §10.2 CoW/copy/跨盘的语义、fallback 与峰值 | 真实独占 XFS reflink 测试卷、XFS → tmpfs 跨盘；相同摘要、独立 inode、双向写隔离；三个 32 MiB 投影 copy 新增 100,728,832 字节，clone 65,536 字节（0.065%）；5 ms 采样峰值分别 101,294,080 / 65,536 字节 | 通过真实 clone、EXDEV 和原 G1 ≤20% 门槛；短于采样间隔的瞬态未承诺捕获，联合空间报告仍归 §8 |
| §10.3 trial/role 写入隔离及 verifier 保密 | Hitch 私有 workspace 单测；shared-tree 和 AutomationBench 的真实 Docker 角色隔离；新增远程 worker 链检查实际交付给 backend 的 candidate/verifier 目录 | 已验证当前 private-copy 后端；CoW 实测仍归 §10.2 |
| §10.4 缺失、损坏、循环、路径、能力、平台、解包炸弹 | 严格 lock/tree/schema、路径碰撞与对象预算；OCI 导入和首次在线 pull 前流式扫描展开 tar、文件数、路径、PAX、diff ID；压缩炸弹及错误归档均在任何 registry 写入或 Docker pull 前失败；两个真实 producer 的镜像层扫描通过 | 当前支持的 gzip/普通 tar 格式已验证；稀疏、未知 codec 和未经验证的 docker-archive 明确拒绝 |
| §10.5 pin/freeze/acquire/GC 各阶段崩溃 | Hitch 32 个实际 SIGKILL 用例覆盖 lease 建立/保护、OCI preparing/active fence、root 发布、lease 结束、quarantine 索引/移动/删除/恢复的前后边界，并发 GC；Gear 8 个 pin ack/retention/cohort/batch 前后故障与重建 adapter 恢复 | 已验证列举的进程崩溃/持久化边界；只出现完整引用或安全保留，未完成 JSON temp 会让 GC 保守停止，不宣称故障后自动清除所有残留 |
| §10.6 worker 失联、重启、迟到结果、旧 generation | v3 controller → worker → backend → result → release 完整链；资源工作区接入真实 remote lost/release-timeout 协议状态机，重新打开 registry/protocol/store 后 GC 仍保留；迟到结果封存后仍需结束确认，错误 epoch/generation 释放被拒绝，确认后只移除 workspace、run root 保留 | 已验证当前协议的失联/重建/迟到与过期释放行为；测试不调用模型 |
| §10.7 空机器离线执行及重复导入 | 新建隔离 DinD daemon，初始 images / BuildKit 为 0，不挂载宿主 Docker socket/缓存；导入后停止 registry 并断开 daemon 外网，实际 shared-tree 答案 3、评分 1；重复导入 0 文件字节 | 已通过；基础设施镜像单列，阶段空间快照及原始证据已保存 |
| §10.8 旧 initial/GEPA/Luna Max 的恢复与复用 | 当前 store/projector/Hitch inspection/recovery 读取 8 个 round、20 个原 absolute-ref projection、29 个物理评测；两组 Luna Max 保持 50/100、53/100；逐 eval 验证 result 缺失时 unknown 及恢复后重复复用，原 273 个文件哈希未变，模型调用 0 | [命名历史实证](evidence/generic-storage/historical-recovery.zh-CN.md)通过；保留原 runtime 身份，不自动迁移早期 GEPA search 语义 |
| §10.9 两种 producer 实际执行、评分等价、核心通用 | shared-tree 资源/legacy 答案 3、得分 1；AutomationBench 同一 snapshot 交叉评分一致、3 个角色镜像入证据；核心无 benchmark 名称分支 | 已验证；AutomationBench 固定 canary 只调用 API search，评分 0 不是业务任务完成 |
| §8 空间核算与峰值 | 独立空 daemon 实际执行，连续 43 次采样包含 dataset/projection、CAS、视图、OCI/BuildKit、workspace、staging、bundle 与证据；联合基线 194,494,464 字节，最高采样 1,355,063,296 字节，回收后 1,087,848,448 字节；Docker 总项只计一次 | 已提交完整作用域的 [联合报告](evidence/generic-storage/joint-space.zh-CN.md)；allocated blocks 不冒充 CoW 独占物理字节，采样峰值为下界，短暂 staging 未捕获不表示不存在 |

## 审计中已修复的问题

- 诊断结果原来未封存资源证据，导致 worker 已结束且结果已封存后仍占用 execution lease/workspace。现在诊断路径与正常结果同样建立持久 run root、封存证据并确认回收条件。
- 远程结果原来只携带物化 tree 摘要，其对象留在 worker。现在只传回新生成的 Dockerfile/物化清单等证明对象，控制端逐项验证、导入并 pin，随后才发布结果。原公共输入不重复嵌入结果 JSON。删除测试 worker 的 resource store 后，控制端仍能独立验证完整 run 闭包。
- dataset seal 和多任务 delivery 统一在一次 admission 内解析同一 OCI 镜像；跨 admission 重新验证，避免对 100 个任务反复解析同一个共享 runtime。
- XFS 实测发现 Linux 默认 `copyFile` 会通过 `copy_file_range` 共享块。Gear 显式 copy/fallback 改为 1 MiB 有界读写，保持普通复制对照的含义；clone/copy 的逻辑身份仍相同。短写和取消句柄收敛测试通过。
- OCI 之前仅限制压缩字节；现在扫描完整展开层并校验 config 的 diff IDs，跨镜像累计离线展开预算。无法验证的 Docker save/load 路径不再交给 Docker 盲目展开，改为明确能力错误。
- 继续验证时，四个新增负向测试复现了两个传输边界问题：离线包中未被所选任务声明的镜像可进入 provider 导入流程；停滞 reader/迭代器会让取消请求仍等待持有 store 锁。现在 OCI 交付清单必须精确对应排序去重后的任务声明，读取等待由接收端主动响应取消/超时，迟到的流也会请求关闭，暂存文件和锁及时收敛；失败导入的保护 lease 仍保留供显式恢复。修复前 4 项失败，修复后连同正常执行/离线 OCI 路径共 16 项通过。

新增真实实测原始记录：[命名历史恢复](evidence/generic-storage/historical-recovery.json)、[联合空间](evidence/generic-storage/joint-space.json)、[XFS clone/copy/跨盘](evidence/generic-storage/xfs-clone.json)、[空 Docker daemon 离线执行](evidence/generic-storage/empty-daemon.json)。历史恢复入口为 Gear `scripts/canary-historical-storage.mjs`；CoW 和空 daemon 入口分别为 Gear `scripts/canary-clone-filesystem.mjs`、Hitch `scripts/canary-resource-empty-daemon.ts`。

最终验证（[结构化记录](evidence/generic-storage/validation.json)）：

- Gear 全量 86 个文件、1,163 项：1,158 通过、4 跳过、1 个测试因验证 PATH 将 Python 指向 `.codex` 而被 notebook 沙箱拒绝。使用系统 Python 单独复验该文件，5 通过、1 跳过；去重后 1,159 项通过、4 跳过，没有未解释失败。没有放宽沙箱或测试断言。
- Hitch 资源、镜像与远程相关 144 项，在并发 2 下全部通过；包括 32 点 SIGKILL 矩阵和 12 项完整 worker 流程。初次并行跑两仓库时的定时测试超时已通过分开复跑定位，没有放宽生产超时。
- 两仓库类型检查、Hitch 干净构建、架构检查（433 个源文件、936 条跨模块边）、语法检查、npm 打包内容检查及 `git diff --check` 通过。打包包含公开 schema/fixtures，未包含 `.evolve-lab`。
- 命名历史、联合空间、真实 XFS clone/跨盘、两个 producer 执行/评分等价与独立空 Docker daemon 离线执行均有实证。各专项数字有重叠，不相加充作全量测试总数。

继续验证（2026-09-24，[结构化记录](evidence/generic-storage/continued-validation.json)）：新增 4 项传输回归用例在修复前全部失败，修复后连同执行与 OCI 专项共 16 项全部通过。随后重跑 Hitch 全量 850 项，842 通过、7 跳过、1 项失败；类型、干净构建、架构、语法和 1,024 文件打包检查通过。Gear 此轮仅更新审计证据，未重跑未变更的全量单测。

本轮也用当前构建重新执行了全部命名历史恢复，8 个 round、20 个原 absolute-ref projection、29 个物理评测均通过身份/评分/重复恢复/unknown 状态核对，273 个原始记录文件哈希未变，模型调用与新评测提交均为 0。[本轮历史原始证据](evidence/generic-storage/historical-recovery-continued.json)单独保存；上述结构化记录同时记录了受测源码、构建产物和日志哈希。

Hitch 既有 DeepSeek 冷构建集成测试在上述完整复跑中受 `auth.docker.io` DNS 超时影响，失败发生在任务镜像的 `FROM node:22.23.0-bookworm-slim` 元数据解析阶段。后续诊断确认宿主 TUN DNS `198.18.0.2` 不响应，而本机 HTTP 代理可用；仅为测试进程设置 `HTTP_PROXY` / `HTTPS_PROXY=http://127.0.0.1:6152` 后，原测试在 40.4 秒内通过，未修改代码、断言或超时。首次专用 builder 构建为 cache miss，第二次复用同一产物，且在不含 pnpm 的真实 linux/amd64 任务容器中运行成功，模型调用为 0。完整套件加本次单项复跑去重后为 **843 通过、7 跳过、0 个未解决失败**；这不是一次新的全量运行。原失败和本次成功日志均保留在结构化记录中。

所有验收使用测试目录、合成输入或原 v4 的只读输入。没有清理、迁移或重新提交用户历史实验。
