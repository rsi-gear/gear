# Gear v2 作者 CLI 快速使用

`gear algorithm` 面向五文件的 Python 或 TypeScript 作者项目。管理员需先准备可用的 `local-harness` profile：真实 Harness Git 仓库、已编译任务集、Hitch、模型目的地、权限和预算都由该 profile 管理。作者的 `run.yaml` 只引用 profile 别名，不提供物理服务配置。

当前已验证从本地 npm tarball 和 Python wheel 初始化、安装两语言模板；TypeScript 项目通过 installed admission 与编译，Python 项目通过导入与 `describe()`。完整 profile-backed `check`、`run`、`resume` 的物理宿主接线仍需单独验收；没有该宿主时命令会明确失败，不会用模拟服务运行。

在尚未发布对应 registry 版本的开发安装中，把已构建的包精确传给 `init`：

```sh
gear algorithm init ./demo-ts --language typescript --template search --profile lab \
  --sdk-package /absolute/path/rsi-gear-0.1.1.tgz
cd demo-ts && npm install && cd ..

gear algorithm init ./demo-py --language python --template search --profile lab \
  --python-sdk-wheel /absolute/path/gear_algorithm-0.1.0a0-py3-none-any.whl
cd demo-py && python3.11 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt && cd ..
```

每个项目恰有五个作者文件：算法、`run.yaml`、`roles.yaml`、`prompts/optimizer.md` 和语言依赖文件。`init` 拒绝非空目录、链接目标和覆盖已有文件。省略本地包选项时，它写入随当前宿主包携带的精确 SDK 版本；能否从 registry 安装该版本需由部署者确认。

管理员把 `lab.yaml` 放在 `GEAR_PROFILE_DIR/lab.yaml`（未设置时为 `~/.config/gear/profiles/lab.yaml`），也可以在首次准入时显式指定 `--profile-file`。以下 Python 命令在**已接通并验收的物理宿主**上使用；TypeScript 项目省略 `--python`：

```sh
cd demo-py
gear algorithm check run.yaml --profile-file /absolute/path/lab.yaml \
  --python "$PWD/.venv/bin/python" --max-frontier-waves 200
gear algorithm explain run.yaml --profile-file /absolute/path/lab.yaml \
  --python "$PWD/.venv/bin/python" --max-frontier-waves 200
gear algorithm run run.yaml --profile-file /absolute/path/lab.yaml \
  --python "$PWD/.venv/bin/python" --max-frontier-waves 200
gear algorithm resume RUN_ID --python "$PWD/.venv/bin/python"
```

`--max-frontier-waves` 是每次新运行显式选择并写入 lock 的实验上限；`200` 只是示例值，不是默认值或科学预算。`check`/`explain` 可生成可清理的编译缓存或临时 scratch CAS，但不创建正式运行的 Campaign/CAS、运行 lock 或提交物理任务。`run` 创建新 run ID 与 `.gear/run/<RUN_ID>.json` 索引；在项目目录执行 `resume RUN_ID` 时，CLI 从索引读取原 lock 路径和摘要，不重新解析 `main` 等别名。也可使用 `resume --lock /absolute/path/run.lock.json`。身份漂移会在新 tick 前拒绝。

`SIGINT`/`SIGTERM` 只停止本地观察，**当前正在执行的 tick 会先结束**；它不取消已提交的模型或 Hitch 工作。外部操作结果不明时，CLI 输出 `needs-attention` 并以非零状态退出，保留原 lock 供对账。公开 `gear algorithm` 不接受旧 `schemaVersion: 1` Campaign JSON；旧 v1 `algorithmCommand` 仅保留为内部回归 oracle。旧接口和样例见[旧 Campaign 指南](algorithm-authoring.zh-CN.md)。
