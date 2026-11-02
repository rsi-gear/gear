# Python Meta 单任务云端验收（2026-11-02）

基于 dev `b0d7f93534b79bfbdae7d5c9c8aa742578eb36eb` 构建的包，在阿里云 ECS 的独立目录安装运行成功。机器可读结果见 [JSON 报告](python-meta-2026-11-02.json)。这次验证覆盖 Python 算法 → 真实 Meta 诊断 → Python 提案 → 真实 Meta 候选生成 → 结果复用，未运行 Target 评估或完整 benchmark。

## 验证内容

- 使用 `examples/algorithms/custom_meta.py`，冻结 Python `FailureAnalysis` 和 `plan_findings`，运行真实 Python worker。
- 一条预设 seed 失败反馈：任务要求把 `42` 写入文件，反馈描述此前只返回了文本。该反馈是测试输入，不是真实 Target 执行结果。
- Codex `gpt-5.6-luna` 成功完成 `diagnose_seed`，返回 Python 声明的 `findings` 字段；诊断未修改 anchor。
- Python 根据第一个 finding 发出 `generate_candidate`；真实 Codex 完成候选修改，候选通过 Pi harness 检查，资源摘要与 anchor 不同。
- 两个 operation 均在重新连接后成功 inspect/submit，receipt 完全一致，事件文件字节未变化，未重复执行模型调用。
- 两个 operation 均 `complete` 且未 declined，测试进程退出码为 0。模型内部可有多次请求；报告没有把两个 operation 等同于两次模型请求，也没有推算费用。

## 环境与限制

Node 22.22.1、Python 3.14.4、Codex CLI 0.160.1。运行目录为 `/root/gear-lab/smoke/python-meta-20261102`，成功证据在 `evidence-proxy`，原部署及已有服务未修改。

该服务器的默认 seccomp 模式在嵌套 user namespace 预检时因能力限制失败，未进入模型调用；成功测试显式选择项目已有的 `bubblewrap-only` 模式。服务器直连模型服务超时，成功测试通过已有 HTTP 代理，保留精确域名限制。因此本报告不证明该服务器的默认 seccomp 模式可用。最初的隔离预检失败和代理未配置时的连接失败均不计为成功运行。

测试脚本为 `scripts/check-python-meta-live.mjs`，接受以下环境变量：

```sh
GEAR_TEST_PACKAGE_ROOT=/absolute/path/to/installed/rsi-gear
GEAR_PYTHON=/absolute/path/to/python
GEAR_TEST_CODEX=/absolute/path/to/codex
GEAR_TEST_CODEX_MODEL=gpt-5.6-luna
GEAR_TEST_CODEX_AUTH_HOME=/absolute/path/to/codex-auth-home
GEAR_TEST_LIVE_OUTPUT=/absolute/path/to/new-evidence-directory
GEAR_TEST_LINUX_ISOLATION=bubblewrap-only
# 如宿主需要代理，显式设置 HTTP_PROXY / HTTPS_PROXY / NO_PROXY。
# 导出上述变量后运行：
node scripts/check-python-meta-live.mjs
```

脚本默认使用 seccomp；输出目录必须尚不存在。凭证、原始模型日志与服务器配置不提交到仓库。JSON 报告记录已安装 tarball、测试脚本及运行实现的 SHA-256，以区分实际验证对象。

## 本地回归与边界复查

- Python：Meta policy、算法、阶段晋级、算法协议、经验策略共 48 项通过。
- TS：执行、恢复等相关测试 68 项通过；新增冻结策略、长指令与非法结果相关定向测试通过；经验存储、上下文和容量共 21 项通过。
- 类型检查、ESLint、Prettier、Python Ruff/Mypy、分层检查和协议生成一致性检查通过。
- 复查补迁了经验记录和检索对 `hypothesis` / `semantic_targets` 的解释。TS 剩余同名字段属于持久化格式和通用读接口；默认算法名称、operation 分发、预算、授权、候选写入及 held-out 验收属于执行协议。算法提示词、诊断结构、提案和相关策略均由 Python 定义。
- 本次实现身份会随 Python 策略和 TS 执行适配变化；未验证旧运行自动跨版本恢复。
