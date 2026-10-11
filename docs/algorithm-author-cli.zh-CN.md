# 算法 CLI 快速使用

需要 Node 22.19+ 或 24+、POSIX 文件锁，以及 Python 3.11+（Python 作者）。本分支尚未发布到包仓库；先从同一 checkout 生成 npm tarball 与 Python wheel，再在独立项目安装：

```sh
# 在此 checkout 中
npm run build
mkdir -p /tmp/gear-sdk-artifacts
npm pack --ignore-scripts --pack-destination /tmp/gear-sdk-artifacts
python3.11 -m pip wheel --no-build-isolation --no-deps ./packages/python-sdk --wheel-dir /tmp/gear-sdk-artifacts

# 在仓库外的空目录中
mkdir -p /tmp/gear-author-demo
cd /tmp/gear-author-demo
npm install /tmp/gear-sdk-artifacts/rsi-gear-0.1.1.tgz
python3.11 -m venv .venv
.venv/bin/python -m pip install /tmp/gear-sdk-artifacts/gear_algorithm-0.1.0a0-py3-none-any.whl
PATH="$PWD/.venv/bin:$PATH" npx gear algorithm init ./my-search python
```

构建 wheel 需要解释器已安装 `setuptools` 与 `wheel`。后续 CLI 命令也使用该虚拟环境的 PATH，或把生成配置的 `algorithm.interpreter` 改为 `.venv/bin/python` 的绝对路径。对应版本发布后可用包仓库安装；这里的验证绑定本分支构建产物。

模板生成 `algorithm.py`、`gear.algorithm.json` 和 `requirements.txt`，默认是可运行的 recorded best-of-N。把配置中的 `algorithm.interpreter` 指向安装 wheel 的解释器；例如虚拟环境的绝对路径。模板不自动安装环境。TypeScript 使用 `init ./my-search typescript`，生成真正的 `algorithm.ts` 和 `package.json`，CLI 使用包内 TypeScript 编译器加载，无需启用 Node 原生类型剥离开关。父目录安装的本地 tarball 可直接供它载入，也可独立运行 tsc 检查；模板中的版本依赖是发布声明，本分支开发时使用上述本地产物。

```sh
export PATH="$PWD/.venv/bin:$PATH"
npx gear algorithm check ./my-search/gear.algorithm.json
npx gear algorithm explain ./my-search/gear.algorithm.json
npx gear algorithm run ./my-search/gear.algorithm.json
npx gear algorithm resume ./my-search/gear.algorithm.json
```

仓库构建后同样可用 `node lib/cli.js algorithm ...`。`check`/`explain` 加载作者与宿主、校验配置和身份，不提交 Campaign 操作；真实模型宿主可能查询服务元数据。`run` 只创建新 Campaign；已有状态用 `resume`。它持续观察 running 操作，无需每次手动重启。SIGINT/SIGTERM 停止观察，保留已提交工作供恢复。

默认 `gear.algorithm.json` 的核心字段：

```json
{
  "schemaVersion": 1,
  "kind": "algorithm-campaign",
  "authoring": "step",
  "host": "recorded",
  "campaignId": "my-unique-search",
  "stateDir": "./.gear/my-unique-search",
  "concurrency": 8,
  "algorithm": {"language": "python", "interpreter": "python3.11", "module": "./algorithm.py", "export": "search"},
  "config": {"n": 4},
  "budget": {"rollout.trials": {"unit": "trials", "limit": 100, "source": "execution.rollout", "capability": "hard"}}
}
```

`config` 是算法自己的科学参数；`concurrency` 是运行设置，可按可用容量改为 20 等正整数。预算来源由安装的宿主/provider 决定。每个实验使用新 campaignId 与独立状态目录，目录位于项目内时必须在 `.gear/` 下。恢复使用相同的源码、依赖、配置和物理身份。

recorded 宿主给出确定性教学分数，不代表真实模型能力。要走真实 Git/DSH/Hitch，移除 `host`，添加 `hostProfile: {"language":"typescript","module":"./physical-host.mjs","export":"hostProfile"}`，由管理员提供[共用物理配置](../examples/algorithms/step-search/README.md#物理执行)。三个不同控制结构与 best-of-N 共用同一个宿主。

`npm run test:algorithm:package` 会打包 npm 与 wheel，在仓库外安装，并实际执行两语言 init/check/run/resume、TypeScript 类型检查及三个示例。它验证 recorded 路径；真实模型与 daemon 集成单独验收。
