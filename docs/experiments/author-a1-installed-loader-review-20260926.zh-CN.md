# A1 外部作者包加载审计

本切片让外部 ESM 作者项目使用 `rsi-gear/algorithm/author` 导入，并由宿主负责 TypeScript 编译和一次性声明读取。作者不需要提供 worker 路径、手写构建脚本或自行连接 replay。

## 已验证

- 精确 npm 版本与带完整性信息的 lock；本地 file tarball 支持项目外路径并校验 SHA512。安装后的实际包内容独立封存，不把版本字符串当作代码身份。
- TS/JS/MTS 相对依赖闭包、提示词、SDK、编译器、Node 和产物身份；拒绝未封存的裸包、动态导入、已知直接 IO 和排除目录导入。源码检查不是任意代码安全沙箱。
- 作者和 worker 使用同一个安装后的 SDK 入口，避免两套 ManagedCall / AsyncLocalStorage。每次重放仍使用新进程。
- Python v2 在首次准入封存声明及配置 schema，继续复用已完成准入的首个 worker；声明摘要计入源身份。
- 编译前拒绝已有缓存目录的 symlink；编译缓存位于 `.gear/author-emit`。check 可产生此可清理缓存，不能宣称零文件写入；它不应创建 Campaign/CAS/运行锁或执行物理任务。

实施者在隔离副本通过构建、全仓类型检查以及相关 92 项回归。主审在 `/private/tmp/gear-loader-snapshot` 独立执行 installed-package、python-description、python-kill 三文件，7 项通过（含外部 npm pack 安装、三波 Campaign、新进程恢复和 Python 中断恢复）。这不替代完整 author CLI 或真实 Hitch 验收。

## 审查修正

补齐实际递归 source graph 与 `.mts` 身份；禁止从身份扫描排除目录导入；有界 regular-file 读取在分配前检查并拒绝 symlink；安装模式拒绝 NODE_OPTIONS/NODE_PATH；普通精确版本与项目外 tarball 均有明确接入路径；缓存目录先核验再创建。

当前安装模式只支持 Gear SDK 裸导入与本地闭合模块。任意第三方 npm 算法依赖仍需后续封存支持，不宣称这一能力已完成。没有访问注册表或验证当前版本已经发布。
