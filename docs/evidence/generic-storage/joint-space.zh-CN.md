# 联合空间实测

本次使用 shared-tree producer 的三个任务描述、一个任务 selection 和已有离线 bundle；从空文件 CAS、空 Docker daemon 开始导入，再断开外网执行 candidate/verifier，最后封存证据并回收工作区。结果为答案 3、reward 1，没有模型调用。可复现入口为 Hitch `scripts/canary-resource-empty-daemon.ts`，原始记录为 [joint-space.json](joint-space.json)。

Docker 使用独立 DinD / VFS，不挂载宿主 Docker socket 或已有层。registry 基础设施镜像预载后建立基线；输入 bundle 和源 dataset 已在基线中。该测试用于核算执行过程，不代表生产 overlay 后端的空间效率，也不用于推算 100 任务的节省比例。

## 口径

- 表内为 allocated blocks（字节），包含目录块。同一 inode 只计一次，各目录范围互不重叠。
- Docker 的 `/var/lib/docker` 作为一个总项，已包括镜像、BuildKit、registry volume 和容器写层。原始记录的 `docker system df` 仅供分项解释，不再次加入合计。
- macOS allocated blocks 不是 CoW 独占物理字节；不将本表称为实际释放空间。真实 CoW 新增物理块使用独占 XFS 的 statfs 差值，见 [xfs-clone.json](xfs-clone.json)。
- 目标采样间隔 250 ms，共 43 次，实际最大间隔 412 ms。各路径和 Docker 按顺序读取，并非原子快照。峰值是采样所得下界；短于间隔的临时文件可能遗漏。
- 导入 staging 的采样值为 0，表示未在采样点捕获到驻留字节，不表示导入没有使用 staging。导入对象和展开 tar 仍由独立预算限制。
- 各项峰值发生时间不同，不能把“各项最高采样值”相加作为联合峰值。

| 范围 | 基线 | 各项最高采样值 | 回收 workspace 后 |
| --- | ---: | ---: | ---: |
| 源 dataset 描述 | 118,784 | 118,784 | 118,784 |
| Gear selection/projection | 0 | 4,096 | 4,096 |
| 文件 CAS（含 tree manifests） | 0 | 61,440 | 61,440 |
| 目录视图/解包缓存 | 0 | 36,864 | 36,864 |
| 活动私有 workspace | 0 | 40,960 | 0 |
| 临时导入 staging | 0 | 0（采样未捕获） | 0 |
| 离线 bundle 输入 | 44,425,216 | 44,425,216 | 44,425,216 |
| 保留 run 证据 | 0 | 24,576 | 24,576 |
| 宿主配置/记录 | 0 | 28,672 | 20,480 |
| 资源引用/隔离记录 | 0 | 81,920 | 81,920 |
| Docker 总项（含 OCI/BuildKit） | 149,950,464 | 1,310,285,824 | 1,043,075,072 |

联合基线 **194,494,464** 字节；最高联合采样 **1,355,063,296** 字节；相对基线增加 **1,160,568,832** 字节。回收工作区后的合计为 **1,087,848,448** 字节。Docker VFS 的临时构建空间使峰值高于结束快照；只报告最终 CAS 大小会漏掉主要占用。

逻辑/传输/复制单独记录：源描述逻辑字节 11,861，selection 2,010，bundle 44,376,253，最终 CAS 6,064，视图 1,837，保留证据 8,505。首次文件对象传输 3,619 字节，重复导入 0 字节；workspace 普通复制 1,849 字节、clone 0 字节。OCI 压缩输入已计入 bundle，展开与缓存占用计入 Docker 总项；没有把传输量或逻辑字节作为物理节省量。

回收后已断言活动 workspace 为 0，execution lease 结束，sealed-run root 仍 active。最后只删除 canary 自建的 DinD 容器及匿名卷，保留报告和封存证据；未执行全局 prune。
