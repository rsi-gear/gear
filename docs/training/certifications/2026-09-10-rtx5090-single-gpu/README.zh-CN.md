# 2026-09-10 单卡 runtime 验收

本地 Gear / Hitch / Harbor Docker + 远程 Slime / SGLang 进程的单卡范围已完成 R1、R2、R3。停机验收后重新核验节点、GPU 与软件身份，正式 preflight 阻塞项为空。全部测试后，实例 `50406574` 已停止，容器及远端模型、检查点保留。

- [runtime lock](runtime-lock.json)：验证后的锁文件；原诊断 request 保持 pending-gpu，不改写历史。
- [公开认证对象](certificate.json)：16 项检查及原始审计制品的摘要、长度，不含凭据或原始 verifier 内容。
- [验收摘要](acceptance.json)：冻结身份、模型制品、数值结果、正式 preflight 与最终实例状态。

认证内容摘要为 `sha256:18f55a8b22c8bf25c994d5571d89c3d6750b7fbe50e28072a0e8fab1bce9f1c9`。范围为 `local-harbor-process-single-gpu-v1`：Qwen2.5-1.5B、已冻结 recipe、1×RTX 5090，以及 lock 指定的 Slime / Megatron / Torch / SGLang / bridge / Harness 身份。重新使用时仍由正式 preflight 核验完整范围。

训练覆盖原批次重放、pending checkpoint 只读导出、提交后恢复，以及恢复 optimizer / scheduler / RNG 后的第二次真实更新。optimizer step 为 1 → 2，scheduler step 为 2 → 4；两批 actor/native policy-token logprob MAE 为 0.01089、0.00930（门限 0.1），token IDs 与 mask 精确一致。

隔离检查覆盖实际 CAS 上传正反例、原始 verifier / canonical 内容、全部 4 个训练凭据及 812 个公开制品文件；真实生成网关的正确凭据通过，9 个未授权或管理请求被拒绝。独立推理进程在训练释放后接管同一 GPU，停止回包丢失后正确协调释放。SSH 断连计费与实例自行到期停止也有实测记录。

独立单样例评估 valid=true、inferenceError=false、reward=0。此认证证明运行与恢复链路，不是模型质量提升或晋升决定。远程 Harbor / Docker 主机及双卡认证按本轮范围延后。

原始 operator audit 及私有制品在控制端保留，权重与 native checkpoint 在模型节点保留；本目录约 11 KB 的公开 JSON 不含模型文件。认证为有原始制品支持的 operator attestation，非 GPU 厂商签名。
