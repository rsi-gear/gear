# 无人值守训练配置

完整配置、启动与真实验收步骤见 [无人值守迭代指南](../../../docs/training/unattended-iteration.zh-CN.md)。本目录不启动服务器或申请 GPU。

1. 准备已冻结的 v2 spec/controller，以及节点、评测 Python 环境、Supervisor、GNU timeout 的真实观察值。
2. 复用 [受管 profile 生成脚本](../managed-native/prepare-profile.py)生成真实环境和模型摘要，选择与模型兼容且已验证的工具解析器、上下文和固定 GPU UUID。训练与评测 GPU 必须分开。
3. 封存全实验训练 schedule，选择显式 `--lr-decay-style constant` 或足够长的 `--lr-decay-iters`。该助手不会修改学习率或运行时认证状态。
4. 构建 Gear，再生成新实验配置：

```sh
node examples/training-loop/unattended/prepare.mjs \
  --controller /srv/gear/base-controller.json \
  --spec /srv/gear/base-spec.json \
  --profile /srv/gear/evaluation-profile.json \
  --output /srv/gear/next-experiment \
  --max-rounds 5 --wall-seconds 28800 --max-rejected 2 \
  --run-recoveries 1 --evaluation-attempts 2
```

输出完整 `controller.json`、`spec.json`、固定的 `native-profile.json` 和节点配置合并片段 `node-profile.patch.json`。输出文件独占创建；已有文件不会覆盖。`engine_digest="derive"` 只用于该助手计算公共 engine identity，输出是实际摘要。其余版本、设备、环境摘要须由部署者提供真实观察。

默认只有一个声明的 proposal；接受后继续该计划，拒绝后以 `no-new-proposal` 结束。需要拒绝后尝试不同输入时，添加 `--proposals /srv/gear/proposals.json`，文件为完整 proposal 数组；可调整 `trainTaskIds`、`updatesPerCandidate`、`rolloutSampling`，每项含不可变 `sourceRef`。不能改变 optimizer/runtime 拓扑来绕过 checkpoint 兼容检查。

将 `node-profile.patch.json` 合并到评测节点原 `node.json`，不要替换节点身份、存储或 job 配置。确认控制端与节点保存的 profile 内容相同，然后启动：

```sh
gear training iterate /srv/gear/next-experiment/spec.json --config /srv/gear/next-experiment/controller.json
```

`started:false` 的准备结果仅说明本地输入检查通过，不证明模型可加载、Docker 路径可达或 GPU 训练已认证。
