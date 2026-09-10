# 真实 Harbor 训练传输检查（2026-09-08）

本轮在本机 Docker 中执行，Vast 实例保持停止，没有增加 GPU 运行时间。它验证真实 Harbor 和独立 worker 进程的训练传输；模型端是确定性 HTTP fixture，**不是 Slime／原生 token／跨主机或 GPU 兼容性验收**。

## 结果

- 使用 Harbor 0.21.0、Docker 中的 Linux amd64 任务镜像、生产默认制品构建器和打包 Node runtime。
- 通过公开 CLI 注册 training binding、worker 并运行独立 worker；daemon 使用生产 `runEval`。
- 模型请求经过 controller/worker relay，校验私有认证、绑定 run、策略版本和逐请求幂等键；三次模型调用驱动两次真实 bash 调用，后一请求包含前次工具输出。
- 验证器确认文件内容为 `first-toolsecond-tool`，reward=1；一次有效 trial 的 run 与模型绑定相同，训练 evidence 可经公开 CLI 读取。
- lease 已释放且有 release confirmation；worker 正常退出；按 lease 所有权检查 Docker 资源已清理；公开 run/eval/worker 文件中未发现模型凭证。

结果为 `eval_ca057679387545aaae69065c84ca8e06`、`run_15bc2eb5ccda4aaca64b15e7aa34add5`。镜像摘要 `sha256:62ff9ac757c839f2af609076da1a70a74c21c95d5b42f3406d9639e3ea2a7761`。归档目录 `/Users/tangyehui/.codex/artifacts/hitch-real-training-20260908` 包含 summary、公开训练 evidence、eval inspection、执行日志与相关源码摘要。

## 本轮发现和修复

1. 输入／结果传输的 Base64 重复分组正则在大制品上产生 `Maximum call stack size exceeded`。改为固定栈空间的线性语法检查，保留大小、内容摘要、路径与权限检查。32 MiB 二进制回归验证实际落盘，并覆盖错误 padding、字符与摘要。
2. Docker worker 曾调用主机执行的制品加载器，把 Linux 制品与 macOS worker 主机平台比较而拒绝。现在单独验证传输制品的任务指定身份和完整性，不创建主机调用。真正的主机加载仍检查平台兼容性，目标平台不符或摘要不符仍拒绝。
3. canary 等待 controller 完成结果导入；worker `--once` 正常退出不再被误判成失败，并明确检查 reward=1。

Hitch 构建、架构和语法检查通过；11 项传输测试、18 项制品及 worker 执行回归通过。前两次失败同样已确认资源清理。

## 复现

在 `/Users/tangyehui/agent-hitch` 构建后运行：

```sh
HITCH_HARBOR_TEST_PYTHON=/Users/tangyehui/.hitch/tools/harbor-0.21.0/bin/python \
HITCH_TRAINING_CANARY_IMAGE=hitch/dsh-node22-test:local \
node dist/scripts/canary-remote-training.js
```

脚本最多等待任务 5 分钟，结束时取消未完成任务并清理本次 lease 所有的资源。要求已有本地 bash 镜像、Harbor 0.21.0 和可用 Docker。它不产生 GPU probe，也不开放尚未通过完整验证的全局远程模型 capability。
