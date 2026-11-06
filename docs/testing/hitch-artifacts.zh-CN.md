# Hitch prepared artifact 验证

`src/adapters/hitch/artifacts.ts` 校验 Hitch 计划、结果和 work item 的 artifact 身份、完整性摘要、任务覆盖及平台/Node 合同，返回按任务排序的绑定。同平台重复试验必须使用相同 artifact；重复、缺失或额外的任务不会被接受。原始回包与规范化绑定都保留在操作者回执中，原材料补取沿用同一份证据。

`preparation.ts` 在 provider 连接阶段使用公开 SDK 准备对应任务平台的真实产物，并将其加入 provider/evaluation identity。`sdk.ts` 校验本机 SDK payload 与 daemon controller 相同、Docker/Harbor 观测一致；同一进程加载 SDK 后若 controller identity 改变，必须重启进程。每次新物理提交前使用公开 `loadHarborArtifact` 检查缓存文件；回包必须匹配事先冻结的 artifact。当前还要求配套 Hitch 的[环境绑定](hitch-environment-binding.zh-CN.md)与[执行前 artifact pins](hitch-artifact-pins.zh-CN.md)。完整 Harbor Python 依赖与已加载模块的证明仍未封闭，不能据此宣称完整运行环境固定。

## 只读协议检查

```sh
npm run build
GEAR_TEST_HITCH=/absolute/path/to/hitch node scripts/check-hitch-conditions.mjs
```

脚本从指定 Hitch 安装的公开 `./evals` API 生成合法 execution plan，通过真实 CLI 的 `eval inspect` 读取合成记录，验证请求参数与 artifact 错配被拒绝。DSH/Pi 均覆盖；没有 daemon 作业、Target 执行或模型调用。

## 实际平台 artifact 准备

```sh
GEAR_TEST_HITCH=/absolute/path/to/hitch \
GEAR_TEST_ARTIFACT_OUTPUT=/tmp/gear-prepared-artifact-proof \
GEAR_TEST_ARTIFACT_PLATFORM=linux/arm64 \
node scripts/check-hitch-artifact-prepare.mjs
```

输出目录必须不存在。平台可选 `linux/amd64` 或 `linux/arm64`，省略时按本机架构选择。需要真实 Docker 和包下载网络；构建器、Node 和包管理器由该 Hitch 安装的公开 API 管理。普通 `hitch prepare` 只准备宿主平台，不能代替这一检查。

脚本从当前 `runtimeMatrix` 读取版本并依次准备 DSH/Pi，检查再次准备命中相同 artifact ID，使用公开 `loadHarborArtifact` 复核文件，并修改自有 artifact 的入口内容来验证完整性拒绝，随后还原并复核。公开计划构造器再把实际 artifact 转为任务绑定，交给 Gear 校验。`report.json` 记录 controller、artifact、入口、依赖锁摘要与平台；输出目录及 Hitch 缓存保留，可用于后续冻结集成测试。

运行只进行安装、版本探测和完整性校验，不验证完整 Target 启动、工具调用或模型闭环。默认 DSH 已切换到上游固定 HMR 依赖的版本，但单独准备成功仍不代表完整启动通过。使用同一真实 artifact 的原生 headless 加载另见 [Target headless 验证](target-headless.zh-CN.md)。

## 生产 provider 的提交前准备

```sh
GEAR_TEST_HITCH=/absolute/path/to/hitch \
GEAR_TEST_ARTIFACT_CACHE=/tmp/gear-prepared-artifact-proof/hitch \
node scripts/check-hitch-preflight.mjs
```

缓存参数可省略，此时创建独立临时缓存。指定的缓存必须没有运行中的 daemon，且没有 eval 记录。脚本只管理自己启动的前台 daemon，在不含模型凭据的子进程中调用生产 `HitchOperationProvider.connect`，用原生平台任务分别准备 DSH/Pi，验证重复连接身份不变以及改写自有缓存入口后文件检查拒绝，还原并再检查。输出 `report.json` 路径和缓存会保留；daemon 退出，模型请求和 eval 数均为零。此检查不验证完整 Target 启动。

安装包旅程设置 `GEAR_TEST_HITCH_PREFLIGHT=1` 时会针对安装后的 provider 执行此脚本；`GEAR_TEST_HITCH` 与可选缓存参数同上。单元/合同测试另外覆盖实际 provider 身份变动阻止 baseline 复用、本地漂移阻止新提交，以及计划/结果彼此一致但与冻结产物不同的拒绝。baseline 合同测试使用受控评估回执，不能等同于真实模型基线验收。
