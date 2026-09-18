# 连接 Meta Agent

Meta 宿主和 Target 模型可以分别选择。两条接入路径使用同一个随包 Refine Skill，以及受限的候选和证据协议。

## Standalone 与外部 Skill

安装 Gear，准备 Target 和数据集，再按 [Standalone 完整字段示例](../../harness-agnostic-refine-skill.md)创建配置。示例中的路径和摘要均需替换成真实值。

```bash
npm install --global rsi-gear@latest
GEAR_SKILL_PATH="$(npm root -g)/rsi-gear/skills/refine"
gear-refine skill-identity --path "$GEAR_SKILL_PATH"
gear-refine serve --config /absolute/path/to/gear-refine.json
```

将整个 `skills/refine` 目录复制或链接到宿主支持的位置，包含 references 和调用元数据；配置与执行使用同一份 bundle，不能只对 `SKILL.md` 计算摘要。

server 输出 ready JSON。保持 server 运行，并在 Meta 宿主环境中设置其返回的 socket 路径：

```bash
export GEAR_REFINE_SOCKET=/absolute/path/from/ready/refine.sock
gear-refine request control.status '{}'
```

通过宿主的 Skill 入口或支持的 `/refine` 调用，也可以自然语言说：“使用 Refine Skill 优化 AutomationBench 的 Marketing 部分，Meta 用 Codex + Astra，rollout 用 DSH + Luna，优化 1 轮。”Meta 会话实际使用的 runtime 和模型需要与配置一致。

## DSH 原生 Skill

按[快速开始](quickstart.md)安装 Gear，再通过 `dsh plugin --profile web add rsi-gear@latest` 加入 DSH profile，按照 [DSH 配置说明](../../plugin-installation-and-usage.md#6-启用并配置-profile)配置并启用 `refine` 行。默认使用 Skill 模式，DSH 发布随包 Skill 和 `refine_request` bridge；原生 `/refine` 手势将 Skill 加载到当前 Agent。

```text
/refine --rounds 1 --focus workflow,tool
/refine status
```

identity 字段全部省略时，插件自动派生 DSH runtime 和完整 Skill bundle 身份。bridge 检查 Skill 加载记录、模型和采样配置；不会证明宿主的其他工具、历史或 OS 权限。`metaAdapter.kind: dsh` 选择旧 direct-session 兼容模式，见[旧模式配置](../../plugin-installation-and-usage.md)。

## 身份与生命周期

外部客户端需要真实的 runtime type/version/integrity、Skill ID/bundle digest、provider/model 和 sampling。`gear-refine skill-identity` 只计算 Skill 摘要，不验证外部可执行文件，也不配置宿主模型；runtime 身份应来自实际安装制品，并与宿主设置一致。

Skill 负责 start、claim、诊断、修改、检查、finalize/decline 及后续候选；操作者无需手拼 lease 参数。[完整协议](../../../skills/refine/references/protocol.md)是权威合同。

普通 start 创建新 evolution；继续时明确给出旧 ID。模型、Skill、runtime 或已封存采样发生变化后，应新建实验。
