# DSH/Pi 容器执行验证

`scripts/check-target-headless.mjs` 验证已构建 Gear adapter 生成的原生载体能在容器内被真实 DSH/Pi CLI 加载、调用原生 bash 并产出可评分文件。它不使用外部模型，不验证模型推理质量，也不替代完整 Hitch 提交、Meta 生成和认证模型闭环。

## 验证范围

每个 adapter 分别执行原载体与修改载体。DSH 修改 `plugins/policy.js`，Pi 修改 `.pi/extensions/policy.ts`，两者都通过原生扩展接口将标记加入系统提示。容器内的受控 chat-completions 服务检查该标记，返回一次 bash 调用及一次结束回复。测试检查实际工具回包和 `/app/answer.txt`，并由 Gear Python benchmark 编译器生成的 verifier 在另一个容器中评分：原载体为有效 0 分，修改载体为有效 1 分。

候选与 verifier 容器都使用 `--network none`；受控模型服务仅监听候选容器内的 loopback。候选没有私有 expected 数据，verifier 只接收候选输出及评分材料。测试不继承宿主模型凭据，只有容器内无认证服务使用的固定测试字符串。

DSH 的固定评测 patch 将 `sandbox-policy.mode` 设为 `danger-full-access`，`approval.policy` 设为 `never`。这里由外层 Harbor 容器提供执行边界；普通容器不能依赖宿主的嵌套 sandbox 后端。该设置仅在 `materialize` 时写入容器构建上下文，不修改 `prepare` 生成的宿主载体，也不是候选可编辑的固定配置。Pi 的容器执行同样使用原生自动批准模式。

## 运行

需要 Docker、已构建的 Gear、Python 3.11+，以及按 OCI digest 固定且包含 Python 的 verifier 镜像。候选平台从输入镜像的实际架构读取，支持 `linux/amd64` 和 `linux/arm64`；verifier 使用其已安装镜像的实际平台，报告分别记录两者。使用跨架构镜像时需要 Docker 模拟支持。

```sh
npm run build
docker build --platform linux/amd64 \
  --tag gear-refactor-headless:probe tests/fixtures/headless

GEAR_PYTHON="$PWD/.venv/bin/python" \
GEAR_TEST_HEADLESS_IMAGE=gear-refactor-headless:probe \
GEAR_TEST_VERIFIER_IMAGE='mirror.gcr.io/library/python@sha256:2f2e5a876c71a6757f55ec57f2add0225ddaf01c802a33fcc29073943f94d907' \
GEAR_TEST_HEADLESS_OUTPUT=/tmp/gear-headless-proof \
node scripts/check-target-headless.mjs
```

输出目录必须尚不存在。报告记录 runtime image ID、两侧平台、CLI 实测版本、verifier digest、实际 adapter 范围、模型请求观测与评分。CLI 的 `--version` 必须匹配 Gear 当前运行矩阵；旧测试镜像不会冒充新默认版本。省略输出目录时使用临时目录并在结束后清理。脚本清理自己创建的候选镜像和全部容器，保留作为输入的 runtime 镜像。可用 `GEAR_TEST_HEADLESS_ADAPTERS=dsh` 或 `pi` 运行单个 adapter；该结果不能视为两个都通过。

独立 npm/wheel 安装旅程也可启用同一验证：

```sh
GEAR_SETUP_PYTHON="$PWD/.venv/bin/python" \
GEAR_PYTHON="$PWD/.venv/bin/python" \
GEAR_TRAINING_TEST_PYTHON="$PWD/.venv/bin/python" \
GEAR_TEST_HEADLESS_IMAGE=gear-refactor-headless:probe \
GEAR_TEST_VERIFIER_IMAGE='mirror.gcr.io/library/python@sha256:2f2e5a876c71a6757f55ec57f2add0225ddaf01c802a33fcc29073943f94d907' \
npm run test:project:package
```

此时 adapter 与 benchmark 编译器来自已安装包，测试驱动来自仓库。安装旅程自己的临时目录在结束后清理。

若已生成 npm tarball，可另设 `GEAR_TEST_NPM_PACKAGE=/absolute/path/rsi-gear.tgz` 让安装旅程直接消费该产物。未设置时仍从当前构建目录打包；使用外部产物时，测试驱动旁的 Python 发布材料应来自同一版本。

## 使用真实 Hitch artifact

测试可直接只读挂载 Hitch 实际准备的 artifact，而不使用镜像中另外安装的 DSH/Pi。先按 [Hitch artifact 检查](hitch-artifacts.zh-CN.md) 执行 `check-hitch-preflight.mjs`，保存它输出的 `report.json` 路径；也可使用 `check-hitch-artifact-prepare.mjs` 的报告。缓存目录和报告必须对应同一批产物，且没有别的进程同时改动这些测试产物。

以下示例使用 ARM64 候选及独立 verifier：

```sh
docker pull --platform linux/arm64 node:22.23.0-bookworm-slim

GEAR_PYTHON="$PWD/.venv/bin/python" \
GEAR_TEST_HITCH=/absolute/path/to/hitch \
GEAR_TEST_ARTIFACT_CACHE=/tmp/gear-prepared-artifact-proof/hitch \
GEAR_TEST_HEADLESS_ARTIFACT_REPORT=/tmp/gear-prepared-artifact-proof/report.json \
GEAR_TEST_HEADLESS_IMAGE=node:22.23.0-bookworm-slim \
GEAR_TEST_VERIFIER_IMAGE='mirror.gcr.io/library/python@sha256:2f2e5a876c71a6757f55ec57f2add0225ddaf01c802a33fcc29073943f94d907' \
GEAR_TEST_HEADLESS_OUTPUT=/tmp/gear-native-headless-proof \
node scripts/check-target-headless.mjs
```

此模式从报告选择与 Gear 当前矩阵及候选平台匹配的产物，通过指定 Hitch 安装的公开 `loadHarborArtifact` 在执行前后核验目录及入口完整性。候选通过真实 artifact 的入口运行，Node 版本必须匹配 artifact 合同；挂载只包含该 artifact，不包含 daemon root 或凭据。报告记录 `execution: hitch-prepared-artifact` 及每个场景的 artifact 摘要。镜像中无需预装 DSH/Pi；上面的 Node 镜像也可替换为相同平台和 Node 版本的现有 Hitch builder 镜像。

独立发布旅程继承这些运行与 artifact 参数，因此可以针对安装后的 Gear adapter 和 benchmark 编译器执行该检查；输出目录由安装旅程放入自身临时目录，并在结束时清理。

## 固定依赖与验证范围

默认 Target 矩阵和普通测试 runtime 使用 DSH `0.1.5-rc.3`、Pi `0.84.1`。DSH 发布包自身将 HMR 固定为 `1.0.17`；测试夹具不再覆盖这一依赖。源码见运行矩阵及夹具锁文件，完整上游产物仍由 Hitch 核验并绑定实际摘要。

此前的 DSH `0.1.1-rc.2` 允许浮动安装到没有 `registerConfig` 的 HMR `1.0.19`，实际生产 artifact 已复现启动失败。测试单独覆盖为 `1.0.16` 曾掩盖这一差异；默认版本现已替换，不改写既有 profile 或运行身份。手动指定旧版本不在当前验证矩阵内。

真实 artifact 下的本地受控响应验证证明启动、扩展、工具和独立评分行为；它不替代 Hitch 完整评估提交、外部模型认证、Meta 生成或推理质量验证。其他未完成项见[实施记录](../refactor-progress.zh-CN.md)。
