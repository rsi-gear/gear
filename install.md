# Gear 安装

支持 macOS 和 Linux，需要 Node.js 24+、Python 3.12+、Git。运行评测还需要 Docker。

## 1. 安装基础工具

macOS（已安装 Homebrew）：

```sh
xcode-select --install
brew install git node@24 python@3.12 ripgrep
export PATH="$(brew --prefix node@24)/bin:$PATH"
brew install --cask docker-desktop
open -a Docker
```

Ubuntu 24.04：

```sh
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential \
  python3 python3-venv bubblewrap socat ripgrep
```

Ubuntu 的 Node.js 和 Docker 分别按 [Node.js 安装页面](https://nodejs.org/en/download)和 [Docker 安装指南](https://docs.docker.com/engine/install/ubuntu/)安装。启动 Docker 后，确认 `docker info` 能正常执行。

## 2. 从 npm 安装 Gear 和 Hitch

```sh
npm install --global rsi-gear@latest agent-hitch@latest
```

两者均安装最新发布版，npm 会自动安装依赖。若遇到 DSH peer dependency 冲突，可使用文末的源码安装方式。

## 3. 安装 Python 依赖

```sh
python3.12 -m venv "$HOME/.venvs/gear"
. "$HOME/.venvs/gear/bin/activate"
python -m pip install ipython
```

Ubuntu 24.04 可将 `python3.12` 换成 `python3`。

## 4. 安装 Harbor

保持 Python 虚拟环境已激活，执行：

```sh
hitch eval setup harbor --python "$VIRTUAL_ENV/bin/python"
hitch eval doctor --python "$VIRTUAL_ENV/bin/python" --json
```

Harbor 由 Hitch 自动安装。

## 5. 安装 DSH 插件（使用 DSH 时）

```sh
npm install --global pnpm@11.7.0 @deepseek-ai/dsh@0.1.1-rc.2
dsh plugin --profile web add rsi-gear@latest
```

按 [插件配置说明](docs/plugin-installation-and-usage.md#6-启用并配置-profile)启用 `refine`，填写模型、任务集、目标仓库和 Python 路径，然后启动：

```sh
dsh --profile web --no-open
```

默认访问地址：`http://127.0.0.1:3080`。使用外部 Meta Agent 则按 [独立控制面说明](docs/harness-agnostic-refine-skill.md)配置。

## 6. 可选依赖

需要 Gear Python 训练模块（自动安装 psutil 和 aiohttp）：

```sh
python -m pip install "$(npm root -g)/rsi-gear/python[gateway]"
```

训练阶段还需要 CodexRunner 时：

```sh
python -m pip install "$(npm root -g)/rsi-gear/python[agents]"
```

需要 LLM Verifier：

```sh
python -m pip install llm-verifier
```

GPU 训练的 Slime、Megatron、SGLang、Ray、PyTorch、CUDA 及补丁安装见 [训练指南](docs/training/README.zh-CN.md#配置和不可变输入)。

## 7. 检查安装

```sh
gear-refine skill-identity
python -c "import IPython; print('Python OK')"
hitch --version
hitch eval doctor --python "$VIRTUAL_ENV/bin/python" --json
```

## 8. 源码安装（开发时）

```sh
git clone --branch dev https://github.com/rsi-gear/gear.git
cd gear
npm ci
npm run build
npm link --ignore-scripts
npm install --global agent-hitch@latest
```
