# Quick start

Use Gear's Refine Skill from Codex, Claude Code, DSH, or another agent that can load Skills and call Gear. Describe the benchmark, Meta agent, rollout agent and number of rounds in natural language to start optimizing.

## Let your agent install Gear

Copy this prompt into your agent to have it handle setup:

```text
Follow https://rsigear.xyz/docs/gear/quickstart to install Gear in my environment.
Install rsi-gear@latest and agent-hitch@latest with npm and check the required dependencies.
Add Gear's complete Refine Skill to my current agent and configure its connection to Gear.
Use my actual task paths, target harness and model settings; ask me for any missing information.
Verify that the Skill can connect to Gear, then report the result and how to start my first optimization.
```

The steps below cover manual installation and the first optimization.

## 1. Install Gear

Gear supports macOS and Linux. Node.js 24+, Python 3.12+ and Git are recommended; Gear also supports Node.js 22.19+. Harbor evaluations require Docker.

### Install platform tools

On macOS with Homebrew installed:

```bash
xcode-select --install
brew install git node@24 python@3.12 ripgrep
export PATH="$(brew --prefix node@24)/bin:$PATH"
brew install --cask docker-desktop
open -a Docker
```

On Ubuntu 24.04:

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential \
  python3 python3-venv bubblewrap socat ripgrep
```

On Ubuntu, install Node.js and Docker using the [Node.js installation page](https://nodejs.org/en/download) and [Docker installation guide](https://docs.docker.com/engine/install/ubuntu/). Start Docker and confirm that `docker info` succeeds. See [platform setup](../../plugin-installation-and-usage.md#22-操作系统要求) for additional sandbox configuration.

### Install Gear and Hitch from npm

Install the latest releases; npm installs their dependencies automatically:

```bash
npm install --global rsi-gear@latest agent-hitch@latest
```

The Gear package includes the `gear-refine` CLI and the complete Refine Skill. If installation encounters a DSH peer dependency conflict, use the source installation steps at the end of this page.

### Install Python dependencies and Harbor

Create and activate a Python virtual environment, then install IPython:

```bash
python3.12 -m venv "$HOME/.venvs/gear"
. "$HOME/.venvs/gear/bin/activate"
python -m pip install ipython
```

On Ubuntu 24.04, you can replace `python3.12` with `python3`. Keep the virtual environment active while Hitch installs Harbor and checks the environment:

```bash
hitch eval setup harbor --python "$VIRTUAL_ENV/bin/python"
hitch eval doctor --python "$VIRTUAL_ENV/bin/python" --json
```

### Install DSH when using it

This example uses DSH as the rollout agent:

```bash
npm install --global pnpm@11.7.0 @deepseek-ai/dsh@0.1.1-rc.2
```

If DSH is also your Meta host, install Gear into the DSH profile:

```bash
dsh plugin --profile web add rsi-gear@latest
```

Follow the [DSH profile setup](../../plugin-installation-and-usage.md#6-启用并配置-profile) to enable `refine` and configure the models, datasets, target repository and Python path in your virtual environment. Then start DSH:

```bash
dsh --profile web --no-open
```

The default address is `http://127.0.0.1:3080`. The next section covers connecting an external Meta agent.

### Check the installation

```bash
gear-refine skill-identity
python -c "import IPython; print('Python OK')"
hitch --version
hitch eval doctor --python "$VIRTUAL_ENV/bin/python" --json
```

When configuring Gear, set its Python executable to the absolute path in this virtual environment.

## 2. Connect the Skill to your agent

Find the installed Skill bundle:

```bash
GEAR_REFINE_SKILL="$(npm root -g)/rsi-gear/skills/refine"
gear-refine skill-identity --path "$GEAR_REFINE_SKILL"
```

Add that entire directory to your agent's Skill catalog using its supported installation method, including the references. Codex, Claude Code and other compatible hosts connect to Gear's standalone control plane. Follow [Connect your Meta agent](meta-agents.md) to configure and start it:

```bash
gear-refine serve --config /absolute/path/to/gear-refine.json
```

Keep the server running. Set the returned `socketPath` as `GEAR_REFINE_SOCKET` in the environment of the agent using the Skill.

For the first run, prepare the [Target Harness](target-harness.md), [benchmark tasks](datasets.md), and the [standalone configuration](../../harness-agnostic-refine-skill.md). You can ask your agent to help set these up using your actual repository, dataset paths and installed runtime identities. Authenticate the Meta and rollout models separately.

Meta and rollout are independent choices. For the example below:

| Role | Runtime and model | Responsibility |
| --- | --- | --- |
| Meta agent | Codex + Astra | Read failure evidence and improve the Harness through the Refine Skill. |
| Rollout agent | DSH + Luna | Execute benchmark tasks with each candidate Harness. |

Use Codex with Astra for this Meta session and match the Gear configuration to its actual model and sampling settings. DSH provides the Target runtime in this example. If you also choose DSH as your Meta host, its [native Skill integration](meta-agents.md#dsh-native-skill) is another connection option.

## 3. Ask your agent to optimize

Load the Refine Skill through your agent's Skill interface or `/refine` where supported. You can also request it in natural language:

```text
Use the Refine Skill to optimize the Marketing domain of AutomationBench.
Use Codex + Astra as the Meta agent and DSH + Luna for rollouts.
Run one round of optimization.
```

The request defines the benchmark scope, two agent configurations and round count. It uses the Harness and benchmark paths prepared above. Gear evaluates the baseline, gives Meta the permitted failure evidence, checks and evaluates candidate changes, and records which Harness to retain.

```text
Show the results of this evolution and the retained Harness changes.
Continue evolution EVOLUTION_ID for two more rounds with the same settings.
```

Use the returned evolution ID when continuing. [Manage evolutions](evolutions.md) explains status, repair and publication.

Next, follow [Example 1: evolve a harness for Marketing](example-harness.md) or [Example 2: customize your evolve algorithm](example-algorithm.md). For model weight optimization, see the separate [experimental training workflow](training.md).

## Optional dependencies

For the Gear Python training module, which installs psutil and aiohttp:

```bash
python -m pip install "$(npm root -g)/rsi-gear/python[gateway]"
```

If training also needs CodexRunner:

```bash
python -m pip install "$(npm root -g)/rsi-gear/python[agents]"
```

For LLM Verifier:

```bash
python -m pip install llm-verifier
```

See the [training guide](../../training/README.zh-CN.md#配置和不可变输入) for GPU training dependencies, including Slime, Megatron, SGLang, Ray, PyTorch, CUDA and patches.

## Install from source for development

Use these steps instead of installing Gear and Hitch from npm above. Complete the other dependency and configuration steps as usual:

```bash
git clone --branch dev https://github.com/rsi-gear/gear.git
cd gear
npm ci
npm run build
npm link --ignore-scripts
npm install --global agent-hitch@latest
```
