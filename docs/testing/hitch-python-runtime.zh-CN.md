# Harbor Python 内容身份

本页记录配套 Hitch 的 `evaluation_environment_binding: "2"` 历史验证：在原环境与凭据绑定中加入实际 Python 内容身份。公开 binding JSON 仍为 schema v1，私有记录升级为 v2；不能拿旧私有记录授权新执行。当前 Gear 已要求 v3，新增范围见[环境文件绑定](hitch-environment-files.zh-CN.md)。该配套实现尚未发布。

检查使用 Harbor launcher 指定的解释器，保留虚拟环境 symlink 的激活语义，记录解释器、虚拟环境配置、实际模块搜索目录、启动时加载模块的文件和 Python 共享库。文件内容发生变化会改变绑定，即使包版本和启动脚本保持不变。准入和每次 Harbor 调用前重新检查；回执和幂等恢复继续引用原绑定。

正常生成的 `__pycache__` 保持身份稳定；当前解释器的缓存须与源码编译结果一致，不一致即拒绝。独立 `.pyc` 按字节绑定，当前解释器不能加载的孤立或其他标签缓存不计入执行输入。检查还检测读取期间的文件、目录变化，并对读取量、条目数和耗时设限。检查程序同时进入 Hitch npm 产物和不可变 controller runtime。

2026-10-12 的当前验证：

- Hitch 五个受影响测试文件 56 项通过，包括同版本依赖变更导致新 binding、旧 binding 在真实 backend 入口被拒绝、正常缓存不改变身份、错误缓存拒绝、控制器冻结清单与 CLI。日志 `/tmp/gear-hitch-python-runtime-final-tests.log`。
- 独立 Python inventory 七项通过，覆盖源码变化、增删文件、symlink 目标变化、正常和错误字节码、相对模块路径及资源限制；由上述 Node 测试实际调用。
- Gear 两个相关文件 74 项通过；类型、lint、格式通过。日志 `/tmp/gear-python-runtime-gear-tests.log` 及同前缀的 types/lint/format 日志。
- Hitch 构建与 442 个源文件、951 条跨模块边的检查通过；`npm pack --dry-run` 确认 Python 检查文件随包提供。
- 真实 Harbor 0.21.0、Python 3.12.13 已完成内容观测；daemon 私有 v2 记录包含 11,363 个文件的身份。公开响应没有暴露清单路径、凭据或端点。
- 独立 npm/wheel 安装旅程通过，包含安装后的真实 daemon v2 绑定与 ARM64 DSH/Pi 产物探针、CLI/SDK、CPU training、取消恢复、OS 隔离算法及导入/评分合同；日志 `/tmp/gear-python-runtime-package.log`。该旅程没有调用模型。
- 新协议下 Pi/Luna baseline `run_fe46c614611e432baca90ac52e0e5272` 完成，故意保留缺陷时得到 1 条有效 0 分；随后 preview 确认可复用同一历史槽位，零新增基线执行。自有 daemon 已结束。报告 `/tmp/gear-python-runtime-luna-pi-1/pi-report.json`，预览位于同目录 `preview.json`。这是 baseline 与复用复验，没有重复完整 GEPA。
- DSH/Luna baseline `run_3ea22d08391e4922ad4426f05b1c772b` 同样完成 1 条有效 0 分及一个历史槽位的复用预览；报告 `/tmp/gear-python-runtime-luna-dsh-1/dsh-report.json`。两个请求的环境绑定、产物 pins、准备结果和 work items 均一致，所用 controller runtime 为 `sha256:2a164e6abf407a683e0db3f746bb3a357f94a9e0571e006b666c168d5d4128ae`，实际 Python 内容身份均为 `sha256:670c84940cadc1537857917702e22856c5ca8a64184cc288ffddeb8d0089d2ca`。
- 汇总证据 `/tmp/gear-python-runtime-luna-proof.json`。115 个指定输出文件未出现原始访问令牌；扫描范围为 Gear 的 Hitch provider 目录与两个对应 Hitch eval 目录，使用实际冻结 helper 凭据与当前登录令牌核对。两次运行均无残留 eval 容器，自有 daemon 已结束。

本实现覆盖上述文件范围，尚不证明任意环境变量引用文件、动态加载的范围外资源、所有系统共享库或运行中的并发主机修改。它没有把可变主机转换为只读运行快照。此前环境绑定与产物约束的运行证据分别保留在[环境绑定](hitch-environment-binding.zh-CN.md)与[产物约束](hitch-artifact-pins.zh-CN.md)，不能把旧 runtime 的测试说成当前实现的完整验收。README 未修改。
