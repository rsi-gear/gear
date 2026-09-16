# 准备 Target Harness

Target 是可构建的确切 Git 版本。Gear 修改声明的 Harness 目录，固定载体提供 runtime 与评测入口。

## 使用示例载体

[快速开始的 bootstrap](quickstart.md)创建独立仓库，记录 substrate、初始 champion 与 manifest。Gear 源码、Target 源码、任务工作区和状态目录应分别保存。Hitch 将确定的 Target 提交构建为不可变制品，在容器中评测。

```text
target/
  fixed/                  # loader、Target 配置、verifier
  harness/
    preset/agent.cordis.yml
    plugins/policy.js
    workflows/            # 可选流程与辅助程序
    skills/               # 载体支持时的原生 Skill
    manifest.json
```

新增文件需要接入实际加载路径。Markdown workflow 不自动成为原生 Skill；Marketing 示例通过 policy 指向已安装资源，由 Agent 显式读取 workflow。

## 评测前验证

`candidate.check` 返回静态及编译/runtime 覆盖。DSH checker 可检查加载、提示组装和原生 Skill 发现/读取；通过检查不代表任意工具、hook 或业务流程已经正确执行。需要时补充针对性运行场景，再跑真实单题评测。

compiler 使用绝对可执行路径，`compiler.runtimeRoot` 指向已安装 Target，配置 `reportProtocol: gear-runtime-check-v1` 才要求结构化 DSH 报告。未启用协议的空操作 compiler 会将 runtime 覆盖记为 `not_checked`。

## 复用最终 Harness

```bash
node examples/automationbench-marketing/inspect.mjs
node examples/automationbench-marketing/inspect.mjs examples/evolution-search
```

检查器对照历史 manifest 验证示例源码。导入新载体时，在 bootstrap 前设置 `GEAR_INITIAL_HARNESS`；新载体获得新 manifest 和 commit，历史指标仍归属于原版本。

凭据由宿主配置提供，不放入候选目录、Git 或导出 Harness。[DSH 编辑参考](../../../skills/refine/references/dsh-target-harness.md)说明真实 hook、tool、原生 Skill 和加载关系。
