# Vast 本地测试产物清理（2026-09-09）

按用户要求，后续迁移使用 Vast 实例间 copy，模型、checkpoint 和安装缓存不再经过本地磁盘。本轮未启动 GPU；实例 `50380854` 在复制前后均为 `actual_status=exited`、`intended_status=stopped`，保留可继续测试的容器。

## 清理结果

- 删除本地 76 个 Gear GPU / Vast 诊断产物目录，以及 244 个相关临时路径和 Vast 地址缓存。
- 删除文件的逻辑大小约 260.51 GB，包含重复模型、历史 checkpoint、HF 导出副本和已延后远程 Harbor 的安装包。APFS 共享块使逻辑大小不等于实际释放量。
- 包括本次临时归档在内的清理完成后，磁盘可用空间从初次盘点约 24.16 GB 增至约 152.62 GB，观察到约 128.46 GB 增量。本地 Vast 临时文件和上述诊断产物目录已复查为零。
- 项目源码、设计文档、CPU 测试环境、Vast CLI 与认证凭据保留；Hitch 用户原有推理文档与其备份仍逐字一致。通用 Hitch 数据库和其他项目资料不属于本次删除范围。

机器可读结果见 [清理报告](vast-local-cleanup-2026-09-09.json)。文件删除过程中遇到生成的只读运行时目录，对本次明确删除范围内的目录补充所有者写权限后完成清理；没有修改外部链接目标。

## 远端保留范围

| 内容 | 实例 50380854 上的位置 | 校验 |
| --- | --- | --- |
| 后续测试使用的 Qwen2.5-1.5B 父模型 | `/workspace/gear-parent-hf-989aa7980e4cf806f80c7fef2b1adb7bc71aa306/` | 停机 rsync checksum 比较，无文件内容差异 |
| 已固定提交与补丁的 Megatron | `/workspace/gear-megatron/` | 停机 rsync checksum 比较，无文件内容差异 |
| 当前恢复诊断源码包 | `/workspace/gear-evidence-20260909/recovery-source-55.tar.gz` | 停机上传并 checksum 比较 |
| 加密历史验收记录 | `/workspace/gear-evidence-20260909/gear-evidence-20260909.tar.gz.aes256gcm` | 本地认证解密和完整 tar 读取通过；停机上传后 checksum 比较一致 |

归档大小 `209177463` 字节，SHA-256 为 `9e7e530bc7d360f1597d654790d9e971e8f9690e4681db342bfeda5170557f66`。归档含 24,256 个诊断文件及 `cleanup-manifest.json`，原有硬链接关系保留；清理清单记录保留及删除文件的路径、长度和修改时间。Vast CLI 本身可能不传播 rsync 失败码，本次额外捕获实际 rsync 退出码并检查 checksum dry-run 的文件内容差异，四次检查均通过。

原始记录含控制端信息，因此上传前使用 AES-256-GCM 加密。32 字节解密密钥仅保留于本机 `/Users/tangyehui/.config/vastai/gear-evidence-20260909.key`，权限为 `0600`，没有上传至模型节点。格式依次为 10 字节 ASCII `GEAR-GCM1\n`、12 字节 nonce、gzip tar 的密文、16 字节 GCM tag；无 AAD。恢复时先核验上述密文摘要和 GCM 认证，再解压所需记录。当前实例的自停凭据保留于本机 Vast 配置目录，未写入公开清理报告。

历史文档中的本地诊断路径现在表示归档内同名路径，不能再当作存在的本地文件。大于 16 MiB 的历史二进制和重复源码包未纳入归档；唯一保留的第 55 轮源码包例外。旧诊断 checkpoint 已明确丢弃，不能再声称历史作业仍可恢复，也不能仅凭日志摘要重新执行其完整权重校验。下一轮故障恢复使用当前代码创建新作业，生成并恢复新的 checkpoint。

## 后续执行约束

实例替换直接使用 `vastai copy C.<源实例>:/workspace/... C.<目标实例>:/workspace/...`，校验完成后删除不可用源实例；未测试完成的可用实例只停止。复制、缓存准备和日志整理均优先在停止状态执行，不为搬运数据计费启动 GPU。

第 55 轮尚未启动训练：SSH 代理返回 `Permission denied (publickey)` 后已停止实例，随后为实例重新附加既有公钥。下一次连接须显式指定现有身份文件，并在有界连接检查成功后启动训练；尚未重新实测 SSH。原临时 runner 的本地路径已随清理失效，不能直接重跑。

本轮没有新增 GPU 验收。单卡实际故障恢复、隔离剩余边界和正式 runtime 认证继续保持未完成。当前 collect 默认下载大对象到控制端；后续须先补齐远端持久化与验收接线，避免重新产生本地模型/checkpoint 副本，不能直接跳过持久化门禁。
