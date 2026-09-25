# A1 作者项目与 CLI 审计

结论：本切片可以提交。它交付五文件初始化、公共 CLI 控制流程、旧报告入口与安装验证；通用物理宿主仍需独立接线和验收。

gear/gear-refine algorithm 转向 v2 作者命令：init、check、explain、run、resume。init 从宿主元数据写入精确 SDK 版本，也接受本地 wheel/tarball，拒绝非空或链接目标，先暂存完整项目再发布。管理员 profile 与物理配置位于作者项目外，五个作者文件不要求 host.mjs。普通 waiting 持续驱动；unknown/需对账由必需的 inspectAttention 暴露并以非零状态退出。SIGINT/SIGTERM 只停止下一次 tick，当前 tick 会先完成，不取消物理作业。

run 生成 ID，发布只指向原 lock 路径与摘要的 .gear/run 索引；resume 不重新解析算法 YAML，并在 tick 前核对索引/锁身份。独立审查发现 RUN_ID 与 --lock 同时出现会跳过索引摘要，现已在调用 backend 前拒绝混用，并增加零调用回归。check 可以创建可清理的编译缓存/临时 CAS，不能说绝对无写入，但不创建正式运行状态或提交物理任务。

旧 schemaVersion 1 Campaign JSON 由公共作者 CLI 明确拒绝；旧 package 回归改为显式调用内部 algorithmCommand，作为测试 oracle，不承诺旧运行接口。gear history inspect 接入已审计的只读 round reader。

验证：实施者在 /private/tmp/gear-author-cli-pack.b9wbcb 直接构建/类型检查通过，并完成 scripts/check-algorithm-package.mjs：离线本地 npm pack/install、Python wheel/干净 venv、两语言五文件初始化、TS installed admission/emit、Python import/describe、公开 v1 拒绝、旧三种 Campaign oracle、录制物理 host check、旧 Search 跨进程恢复。可选 Optuna 未启用。最后互斥输入与文案修正后重新构建和聚焦测试，未重复整套 package 检查。

主审逐字节比对 11 个切片文件与冻结副本，独立 CLI/project 两文件 9 项通过；独立 reviewer 同样 9 项通过并关闭其唯一 P1。reviewer 另外验证外部 TS 模板严格类型检查和 Python 属性别名。上述 CLI 控制测试注入 backend；TS admission/emit 不等同于真正执行生成算法，Python describe 也不是完整搜索。

后续门：productionBackend 从动态函数断言收敛为真实 host 类型；真实装配、冷恢复、完整模板、真实 Hitch 与独立作者试用分别验收。反馈到模型的投影目前等待自动审批要求的明确授权，不绕过、也不将默认示例悄悄改成无反馈来冒充完成。
