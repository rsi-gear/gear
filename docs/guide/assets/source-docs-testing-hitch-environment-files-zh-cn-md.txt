# Hitch 环境文件绑定验证

Gear 当前要求 `evaluation_environment_binding: "3"`，公开 binding 仍为 schema v1。配套 Hitch 位于 `/Users/tangyehui/.codex/worktrees/gear-evaluation-binding/agent-hitch`，分支 `codex/gear-evaluation-binding`，尚未发布；不能仅按 npm 版本 `0.2.16` 判断兼容。

## 实现范围

在驻留环境和冻结 helper 输出、Python 内容身份之外，v3 将证书/凭据配置及声明的自定义文件内容加入 root 私有 HMAC。在 prepare、准入和每次 Harbor 启动前核对；同一路径内容变化产生新绑定，原绑定拒绝执行。时间戳变化不改变身份；默认文件从缺失变为存在也会改变身份。

自动读取范围：

- `SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`、`NODE_EXTRA_CA_CERTS`、`AWS_CA_BUNDLE`。
- `AWS_CONFIG_FILE`、`AWS_SHARED_CREDENTIALS_FILE`、`AWS_WEB_IDENTITY_TOKEN_FILE`、`GOOGLE_APPLICATION_CREDENTIALS`、`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`、`BOTO_CONFIG`、`NETRC`。
- `SSL_CERT_DIR` 目录树，`DOCKER_CERT_PATH` 中的三个标准 TLS 文件，`DOCKER_CONFIG/config.json`。
- 绝对 `HOME` 下未被对应显式变量替代的 `.netrc`、`.aws/config`、`.aws/credentials`、`.config/gcloud/application_default_credentials.json`；未设置 `DOCKER_CONFIG` 时的 `.docker/config.json`。

自定义变量通过 daemon 环境中的 `HITCH_EVALUATION_FILE_ENV_JSON='["MY_PROVIDER_CONFIG"]'` 声明。显式引用须为绝对普通文件路径；未设置或空值忽略。清单限 4096 项、深度 32、单文件 16 MiB、总量 64 MiB；特殊文件、循环链接、超限、读取期间变化均拒绝。绑定包含链接目标、内容和模式，但不持久化文件清单、路径、内容或普通摘要。

helper 凭据仍沿私有通道交给 Target；主机 Python/文件观测使用相应的空占位值，避免误读 Target 内路径。Python 检查兼容没有 `safe_path` 字段的解释器；不支持外置 `sys.pycache_prefix` 缓存，明确拒绝，不能静默忽略其内容。

## 测试记录

Hitch 六个相关测试文件共 64 项通过，Python 清单的 8 项测试也通过；日志 `/tmp/gear-hitch-environment-files-tests.log`。额外使用系统 Python 执行同一清单测试的 8 项通过，日志 `/tmp/gear-hitch-inventory-system-python.log`。首次运行暴露了旧解释器缺少 `safe_path` 字段和系统外置缓存的差异；修正后重新验证，没有把首次失败记作通过。

Gear 的 `project-hitch` 与 `project-onboarding` 共 74 项通过，日志 `/tmp/gear-environment-files-gear-tests.log`。类型、lint、格式、生成合同及依赖边界通过；Hitch 架构检查为 443 个源文件、952 条跨模块边，语法检查通过。npm dry-run 确认新文件清单模块与 Python 检查程序在包内。

独立 npm/wheel 安装旅程通过，日志 `/tmp/gear-environment-files-package.log`。其中真实 daemon 探针 `scripts/check-hitch-environment.mjs` 使用自有临时文件，在 daemon 环境不变时修改文件内容，验证新绑定变化，恢复内容后验证原身份恢复；零 eval、零模型调用。还覆盖真实原生 DSH/Pi 产物准备和错误 pins 拒绝，以及 CLI/SDK、CPU training、取消恢复、OS 隔离、导入与评分。完整范围见[实施记录](../refactor-progress.zh-CN.md)。

本次补丁验证不重写历史模型证据：[v2 Python 内容身份](hitch-python-runtime.zh-CN.md)下的 DSH/Pi Luna baseline 与复用，以及[完整 Luna 搜索闭环](luna-live.zh-CN.md)，仍保留其原有版本范围。

## 验证边界

该协议覆盖列出的文件及显式声明输入，不自动推断所有 SDK 默认文件路径或未声明的自定义资源，也不提供全系统共享库、外部服务或并发主机修改的不可变快照。受支持运行应保持依赖环境稳定；新增自定义文件必须声明。此边界是交付范围说明，不把完整主机可重复执行证明追加为本次代码重构的前置条件。
