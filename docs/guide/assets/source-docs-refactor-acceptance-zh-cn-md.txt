# 重构验收核对

本表对应[原规范第 9 节](project-refactor-spec.zh-CN.md#9-最终验收)，区分代码交付、自动化检查与未实测项目。用户后续决定优先：不保留兼容入口，所有算法决策迁入 Python，训练采用搬迁后整理，README 不修改。当前分支为 `codex/project-refactor`，基于远端 dev `9a1281d`；原工作区和旧运行记录未迁移或改写。用户已回复“不需要模拟了”，U1/P1 保留未实测，不生成模拟参与者或虚构耗时。

完整回归、安装旅程及各次修改的覆盖范围见[实施记录](refactor-progress.zh-CN.md)。历史全量结果不自动覆盖之后的改动；下面区分自动化证据、人工验收和已发现缺口。

| ID | 当前实现和证据 | 判断 |
| --- | --- | --- |
| U1 | 首次使用命令已进入独立安装旅程；没有招募 5 名新用户或记录 30 分钟完成率 | 未实测；按用户回复不模拟 |
| U2 | text/files 模板、CSV/JSONL、preview 与正反例由 benchmark 测试、真实 verifier 和安装旅程覆盖 | 模板自动化证据具备 |
| U3 | 实际分别生成 text/files 项目，`gear.yaml` 均为 8 行，无手填 SHA/socket/compiler；计划预览由 `project-plan.spec.ts` 覆盖 | 配置要求已核对 |
| U4 | macOS 与原生 ARM64 Linux 从 npm/wheel 完成离线安装、setup、doctor 和运行旅程 | 离线安装通过；macOS 另经真实 Luna 认证与运行验证 |
| U5 | 有效零分、缺失、环境失败、评分失败及 smoke 范围由 Project、objective、repair 测试覆盖 | 自动化证据具备 |
| U6 | DSH/Pi 使用同一 benchmark 和 Python GEPA 实现，真实 Luna 分别完成 baseline、诊断、修改、评分和独立 held-out gate；各自复用 1 次历史基线并完成 3 次新执行 | 小型真实闭环通过，见 [Luna 验收](testing/luna-live.zh-CN.md) |
| P1 | [算法索引](search-algorithm-authoring.zh-CN.md) 与两套六模块目录一致；尚无新开发者 10 分钟定位实验 | 未实测；按用户回复不模拟 |
| P2 | 单文件公开 ParentPolicy 替换、CPU toy round、同步/异步 SDK 和冻结代码由 Python 与安装旅程覆盖 | 自动化证据具备 |
| P3 | GEPA/RandomSearch 共享公开合同，分别安排 local/bridge/global 与 global 流程；算法测试验证阶段差异 | 自动化证据具备 |
| P4 | 源码/声明依赖身份、确定性随机、重复响应、冻结恢复和持久决策由 worker/runtime 合同测试覆盖 | 算法边界已覆盖；外部执行身份见 R1 |
| P5 | 单个 `gear` 包提供 benchmark/algorithms/refine/training；基础 wheel 无 GPU 导入、CPU loop、移除旧包均经安装验证 | 自动化证据具备 |
| P6 | 训练基建/后端/流水线/CLI 已拆开，TS 子进程及 Python 模块路径均迁移，恢复身份保留实际源码 | 按用户要求删除旧转发；未以新 runtime 恢复旧任务 |
| P7 | DSH 直接修改 plugin、Pi 直接修改 extension，真实 CLI 的 bash 产物经独立 verifier 从 0 分变为 1 分 | 受控响应下真实行为通过；非外部模型证据 |
| C1 | 原子 admission、持久预约、未知提交、丢失回包、独立取消连接、Codex 作业/目录/登记表丢失、进程锁故障及 champion CAS 有故障注入回归；真实 Hitch 零作业停止协议与 Codex 进程退出已验证 | 自动化证据具备；另有实际 Hitch/DSH/Pi 搜索闭环 |
| C2 | Python/Meta 独立 OS sandbox、seed 视图、受控轨迹读取、研究模式与 held-out 分区有合同与实际隔离测试 | 自动化证据具备 |
| C3 | 旧实现夹具及其专属测试已按用户要求删除；当前 Python 采样、排名、保护、预算、阶段流程和断言固定向量由生产路径测试覆盖 | 历史迁移验证记录保留；不再编译旧执行器 |
| C4 | 旧记录未改写，旧代码由原 Git 版本保留；新运行使用新源码身份 | 不提供新版本兼容入口；旧任务需匹配原 runtime |
| Q1 | 清理旧夹具后，全量 TS 615 通过、3 跳过；Python 共 402 项、4 跳过；strict 类型、formatter/lint、生成合同、公开导出、依赖边界及独立 npm/wheel 旅程通过 | 当前生产路径检查通过；旧夹具不再计入覆盖 |
| Q2 | 当前中英文指南、发布资源和安装命令已同步，教程材料随包提供 | 当前指南与自动化旅程覆盖；README 按用户要求未修改 |

## R1：执行条件绑定与验证边界

本轮复现并修复了 Hitch 回包未核对模型与执行参数的问题：16 个错误条件在旧实现中被接受，修复后被拒绝；原材料补取使用同一校验。该校验封存进 provider 实现身份，变化会影响新运行身份。

Hitch 的 npm revision identity 只绑定顶层包的 version/tarball integrity；随后准备的 artifact 另有依赖锁、工具链与目录完整性。Gear 现通过公开 SDK 在 provider 连接时准备任务平台对应的 artifact，并将目录/入口摘要、平台与任务绑定加入 provider/evaluation identity。准备前后核对 SDK 与 daemon controller、Docker/Harbor 观测；新提交前复核缓存文件，计划/结果/work item 必须匹配预先冻结的绑定。真实 Hitch 0.2.16 + 原生 ARM64 Docker 的 DSH/Pi 零作业探针验证了重复身份稳定与缓存篡改拒绝；受控评估回执的跨 run 合同测试验证了 artifact 变化不再复用 baseline。

daemon 环境与 helper 输出现在由配套 Hitch 的 `evaluation_environment_binding: "1"` 协议提供 root 私有 HMAC 绑定，进入 Gear provider 身份，并在准入、Harbor 启动与回执接纳时核对；环境变化不再复用旧 baseline。新协议下的 Pi/Luna 完整闭环和 DSH/Luna baseline 已通过，具体依赖分支及验证范围见[环境绑定](testing/hitch-environment-binding.zh-CN.md)。该能力尚未发布，现有 Hitch 0.2.16 安装不一定支持。

执行前产物约束已由配套 Hitch 的 `evaluation_artifact_pins: "1"` 协议关闭：Gear 提交冻结的平台、产物 ID、目录和入口摘要，Hitch 在准备后和每次 Harbor 执行前强制核对。请求持久化、幂等、恢复和重试均保留原 pins。真实 ARM64 DSH/Pi 产物的错误 pins 在模型执行前被拒绝；新协议下两者的 Luna baseline 与复用预览通过，见[产物约束验证](testing/hitch-artifact-pins.zh-CN.md)。

此前的环境绑定 v2 已将实际 Harbor Python 解释器、虚拟环境配置、模块路径文件、启动时加载模块及 Python 共享库纳入私有绑定。正常字节码缓存不引起漂移，不一致缓存拒绝；同版本依赖修改会改变新绑定，旧绑定在执行前被拒绝。该版本的受影响回归、安装旅程与 DSH/Pi Luna baseline 复用均通过，范围见[Python 内容身份验证](testing/hitch-python-runtime.zh-CN.md)。

环境绑定 v3 进一步覆盖标准证书/凭据配置和显式声明的自定义环境文件，私有 HMAC 绑定实际内容、模式与链接目标。主机检查使用 helper 空占位环境；内容漂移在新准入与执行前拒绝。实现范围和新增验证见[环境文件绑定](testing/hitch-environment-files.zh-CN.md)。

验证边界包括：未声明的自定义文件、未列出的 SDK 默认路径、动态加载的范围外资源、所有系统共享库及运行中的并发主机修改。该实现不提供完整主机快照，应在稳定依赖环境下运行并声明自定义文件。默认 DSH 已升级到 `0.1.5-rc.3`，其上游精确固定 HMR `1.0.17`；真实 Hitch artifact 在 ARM64 容器下通过插件加载、原生工具和独立评分，之前的 HMR 启动缺口已在该矩阵关闭。手动选择旧版本不在此验证范围内。

环境观测的真实 daemon 探针可用 `GEAR_TEST_HITCH=/absolute/path/to/hitch node scripts/check-hitch-environment.mjs` 执行（先构建）。它使用临时状态与不含模型凭据的环境，验证重复观测及错误身份拒绝，清理自有 daemon；不创建评估作业。独立发布包旅程可通过 `GEAR_TEST_HITCH_ENVIRONMENT=1` 启用同一检查。

已交付的身份约束、固定环境跨 run 复用和失败拒绝按上述范围验收；不将它们扩大解释为任意主机或外部模型服务的完全可重复执行保证。完整主机快照不追加为本次代码重构的前置条件。已完成的真实跨 run 复用见 [Luna 验收](testing/luna-live.zh-CN.md)。

## R2：外部验收输入

用户已指定使用 luna。已利用本机现有登录，以 `gpt-5.6-luna` 完成 DSH/Pi 的真实 Meta 候选生成；DSH 重连和重复提交保持原回执与事件文件不变。`gpt-6-luna` 被本次登录对应的服务端拒绝。DSH/Pi 均完成 Hitch Target 单题执行，以及 Python GEPA 的真实诊断、候选生成、基线复用和独立 held-out gate。具体版本、范围与证据见 [Luna 验收](testing/luna-live.zh-CN.md)。不再以缺少模型选择作为阻塞。U1/P1 保留未实测，不模拟、不填完成率，也不把该回复表述为真人实验通过。

AutomationBench 官方固定版本全量数据、资源协议 v2 的原生导出及 GPU 作业也未作为本次结果验证。已完成的合成 Harbor/Compose 与 CPU 测试仅证明其明确覆盖的范围。
