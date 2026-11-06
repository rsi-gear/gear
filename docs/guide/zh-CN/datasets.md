# 任务与评分

`gear init` 生成可编辑的 `tasks.csv` 和 `benchmark.yaml`。CSV 的基础列为 `id,instruction,expected,family,split`，也支持 JSONL。每题显式指定 `seed` 或 `held_out`；同一 family 或相同任务内容不能跨两个分区。

```csv
id,instruction,expected,family,split
sum-01,Output only the result of 2 plus 3.,5,arithmetic,seed
word-01,Output the uppercase form of apple.,APPLE,case-conversion,held_out
```

演示数据只检查流程。真实效果评估应使用足够规模的任务和明确的划分依据。

| 模板 | `expected` | 评分规则 |
| --- | --- | --- |
| `text` | 字符串 | 显式 trim、casefold、collapse_whitespace 后比较 |
| `json` | JSON Pointer 到预期值的对象，如 `{"/count":2}` | 字段值与 JSON 类型相等，布尔值不当作数字 |
| `files` | 文件路径到内容的 JSON 对象 | 按指定相对路径检查文件内容 |

附件通过 `attachments` 指定项目内相对路径；CSV 中用分号分隔。编译冻结附件字节及任务身份，拒绝链接和路径逃逸。编译后的 expected 留在 verifier 资源，不进入 Target 指令或 Meta seed 投影。确定性和 Python 模板在独立 verifier 容器中评分，传递候选的 `/app` 产物，评分侧网络为 `no-network`；原生 Harbor 导入保留上游已有的 shared/separate 配置。

```sh
gear benchmark check
gear benchmark preview sum-01
gear evaluate --split seed --limit 1
```

`check` 不调用模型，检查数据、分区、规则和确定性正反例。`preview` 显示作者视角的规则与 expected，不能作为 Meta 输入。单题 evaluate 测试 Target 的真实执行和评分。

## 环境和评分器试跑

```sh
gear benchmark probe --task sum-01
gear benchmark probe --task sum-01 --scorer
```

probe 明确构建并启动 seed 任务的 Docker 环境；可能下载镜像或 Dockerfile 中的依赖。默认使用已选 Hitch Target profile 的固定基底镜像，也可传 `--image IMAGE` 从本地解析镜像标签。确定性和 Python 模板无需连接模型或启动 Hitch 评测；LLM 模板的显式 `--scorer` 会访问声明的评判模型。省略 task 时选择第一题 seed；不接受 held-out。

`--scorer` 额外把已冻结的正反例输出放进容器，执行正式 verifier。每个 fixture 使用独立的输出/日志目录，验证脚本退出状态、结构化评分与 reward 一致性。有效零分参与自测；缺失或损坏结果标为评分失败。确定性和 Python 容器验证禁用网络，不传入模型凭据；LLM 的联网和凭据范围见下文。未加 `--scorer` 时只检查环境，不宣称评分器已验证。

报告保存到 `.gear/probes/`，包含 benchmark、scorer、编译器和镜像身份、分项结果、模型用量/费用和待清理资源。确定性与 Python probe 的模型用量和费用为零。它不是 baseline，不写实验预算或晋级账本。取消会尝试回收容器，未确认清理的资源列在 `cleanup_required`。Python 使用 `Project.probe_benchmark(...)` / `aprobe_benchmark(...)`，Skill 使用 `benchmark.probe`。

## 导入和审核分组

```sh
gear benchmark import /path/to/tasks.jsonl --template text
# 审核输出中的 task IDs、分组和 validation_mode，再使用返回的 plan_id：
gear benchmark import --apply import_...实际返回的摘要...
gear benchmark check
```

CSV/JSONL 可省略 split。导入器按 family 与相同输入合并不可分组，保留已有注释，对其余组按固定 hash 顺序分配约五分之一到 held_out。不能形成两个独立组时拒绝 holdout 导入；只有明确传 `--research` 才采用同集研究，报告标明“同集优化，未做独立验证”。部分显式分组发生冲突时也会拒绝，不静默重分配。

预览将源文件和附件字节保存在 `.gear/imports/` 的私有方案中，不更换当前 benchmark。应用时写入 `benchmarks/import-<digest>/`，保存 `tasks.jsonl`、`splits.json`、附件和版本化 importer 身份，再原子切换 `gear.yaml`。原任务数据保留。预览后源文件变化不会进入已保存方案；项目配置或目标目录发生变化则拒绝覆盖。每次运行读取保存的 split，`check` 不重新分组。

附件默认相对输入 CSV/JSONL 所在目录解析；跨目录数据可用 `--resource-root DIRECTORY` 明确共同根目录，源文件和附件都必须位于其中。复制后的路径写入 `resource_root` 配置；每个方案的源数据和附件合计最多 16 MiB。JSONL 报错使用原始物理行号，含空行；错误 JSON、重复字段和非有限数值在模型调用前拒绝。

Python SDK 对应 `Project.import_benchmark(...)`、`apply_benchmark_import(plan_id)` 及 async 入口。Skill 对应 `benchmark.import`、`benchmark.apply`。

## 原生 Harbor

```sh
gear benchmark import /path/to/harbor-tasks --template harbor
gear benchmark import --apply import_...实际返回的摘要...
```

支持单任务目录或数据集目录下的 Linux 单步 Dockerfile/预构建镜像任务；保留原 instruction、task.toml、环境、tests、solution 和空目录。目录结构也进入身份与重试检查，避免 Dockerfile 的 COPY 路径在搬迁后丢失。family 取 metadata.family、metadata.domain、metadata.category 或任务目录 ID。tests/solution 只进入私有 verifier 包，不进入公开任务对象或 Meta 任务投影。

导入从本地 Docker 解析外部 FROM 镜像标签；缺少镜像时提示 `gear setup --hitch --image IMAGE`。已有预构建镜像转为固定摘要的 Dockerfile 基底，使候选修改仍会被构建进去。单步 Linux Compose 环境保留 main、sidecar、depends_on、健康检查、显式环境变量和 artifact service；main 可以使用独立构建目录，Target carrier 追加到其实际 Dockerfile。独立 verifier 和 sidecar 的 FROM，以及镜像服务的 image 也固定到摘要。动态 ARG 镜像名、多步、Windows、宿主目录挂载、外部 Compose 资源和宿主变量插值明确拒绝；这些输入需要先整理为自包含任务。任务 reward 须满足当前评测协议的 0–1 范围。

原生 payload 通过摘要共享相同字节，最多 64 MiB 独立内容、4 GiB 展开内容、100000 个文件和 100000 个目录；不会为每个任务重复传输整个 runtime。CSV/JSONL 的 16 MiB 限制不变。

版本化 producer 的 `benchmark.adapter.json` 会校验任务全集、可执行位、文件和数据集摘要，保留 scoring 与 raw_metrics 合同。导入后保留原始 `source-manifest.json` 和 `source-benchmark.adapter.json`；镜像规范化、任务子集选择及 Target carrier 写入后重新生成执行清单。来源版本和执行版本因此都可核验。Harbor v1 摘要使用其规定的 JavaScript JSON/排序语义，由随 Python 包发布的 Node codec 计算；这是协议编码，不包含搜索算法。资源协议 v2 需先用对应 producer/Hitch 导出原生目录，不能将其当作 v1 清单读取。

Harbor 原生 verifier 的静态检查不执行脚本，其 `verifier_fixtures` 与 `environment` 均为 `not_run`。probe 可以构建并启动原生 main 与 sidecar，等待声明的健康检查，并在失败或取消后清理本次 Compose project；原目录没有 Gear 声明的正反例 fixtures，因此 `--scorer` 仍返回 `not_run` 及原因。使用 seed evaluate 验证真实执行和评分。LLM rubric 使用下文的独立声明和计费自测，不能把原生导入或环境 probe 成功当作模型评判已经验证。

## 自定义 Python 评分器

进阶模式使用单个 UTF-8 Python 源文件，返回 `bool`：`True` 为通过，`False` 为有效零分。连续数值、空值、异常或超时均属于评分失败，不能混入 `pass_rate`。文件只依赖标准库；同目录的其他模块不会自动打包。评分器须离线运行，显式声明零模型请求；计费 LLM rubric 使用下一节的独立合同。

```python
# scorers.py
def score(actual, expected, artifacts, *, seed):
    return actual.strip() == expected and artifacts.get("proof.txt") == "proof"
```

函数须命名为入口指定的顶层同步函数，参数为 `(actual, expected, artifacts, *, seed)`。`actual` 是 `/app/answer.txt` 内容，`expected` 是私有预期值，`artifacts` 只含显式声明且存在的文件。Python 模板保留 CSV 的 expected 字符串；JSONL 可直接提供 JSON 值。框架在导入前设置标准库 `random` 的种子，并把 `seed` 传给函数；作者仍须避免时钟、未固定的随机源等非确定性依赖。

```yaml
version: 1
source: tasks.jsonl
template: python
scorer:
  entrypoint: scorers.py:score
  version: "1"
  randomness: {seed: 7}
  cost: {model_requests: 0}
  artifacts: [proof.txt]
fixtures:
  sum-01:
    - actual: "5"
      artifacts: {proof.txt: proof}
      score: 1
    - actual: "wrong"
      artifacts: {proof.txt: proof}
      score: 0
```

每个任务都要声明一正一反例，包括 held-out；不要把上面的单题片段当作完整独立验证数据集。源文件路径相对项目根目录。源码、入口、版本、随机种子、费用声明、文件清单与 fixtures 一并冻结，任何变化都会改变 benchmark 身份。Target 环境不包含评分源码或 expected。

`benchmark check` / `preview` 只解析源码和合同，不导入 Python 文件、不执行 fixtures；`verifier_fixtures` 明确为 `not_run`。显式 `benchmark probe --scorer` 才在无网络、无模型凭据、有时间和资源限制的 Docker 容器内运行正反例。报告记录 scorer 版本、源码摘要、随机种子、费用声明和各项结果；正式评测使用同一冻结实现。缺失文件不作为空文件传入，评分器按任务规则决定是否判失败。

## LLM rubric

`template: llm` 显式使用一个评判模型，根据 rubric、任务、私有 expected 和候选产物返回通过/不通过。先运行 `benchmark check` 查看规则、模型、随机性和费用声明，再用 `benchmark preview TASK_ID` 审核正反例。两条命令均不读取密钥、不调用模型；只有正式评测或显式 `benchmark probe --scorer` 才可能计费。

```yaml
version: 1
source: tasks.jsonl
template: llm
scorer:
  version: "rubric-1"
  protocol: chat-completions@1
  endpoint: https://api.openai.com/v1/chat/completions
  api_key_env: GEAR_SCORER_JUDGE_API_KEY
  model: YOUR_PINNED_MODEL_ID
  rubric: "只有输出满足任务要求且与参考答案一致时通过。"
  randomness: {temperature: null, seed: null}
  cost:
    price_version: "replace-with-your-price-version"
    input_usd_per_million: 2
    cached_input_usd_per_million: 1
    output_usd_per_million: 4
  limits: {max_request_bytes: 65536, max_completion_tokens: 512, timeout_seconds: 30}
  artifacts: []
fixtures:
  sum-01:
    - {actual: "5", score: 1}
    - {actual: "wrong", score: 0}
```

模型 ID、单价和价格版本必须替换为实际配置；上面的价格只是协议示例，不是服务商报价。每题仍须声明一正一反例；配置、rubric、源码版本和 fixtures 都进入冻结身份。评判模型必须支持请求中的结构化输出，响应 model 须与声明完全一致；别名解析到不同模型会被拒绝。`null` 表示省略采样参数，显式温度或种子须由所选模型支持，固定种子不保证确定性。见 [Chat Completions 官方协议](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 和 [结构化输出及拒答](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat)。

密钥只引用 `GEAR_SCORER_*_API_KEY` 环境变量，不写入 benchmark、候选或锁文件。probe 从当前进程向评分容器传递这一项引用；正式 Hitch 评测须在执行 verifier 的 worker 环境中提供该变量，禁止放入 Target profile 的 `passEnv`。LLM 使用独立联网 verifier，固定 HTTPS endpoint，不跟随重定向、不继承代理环境配置。普通 Python/确定性评分器保持无网络。

每个 fixture/trial 最多发出一次请求，限制请求字节、完成 token 和时长；不会自动重发可能已经计费的请求。HTTP 错误、拒答、截断、无效结构或模型身份变化都是 `scoring_failed`，不算有效零分。请求前持久化用量标记，丢失响应时保留未知调用数/token/费用；有效响应保留实际 token 数。`estimated_model_cost_usd` 按声明单价估算，`model_cost_usd` 不伪装成已确认账单，也不承诺美元硬上限。正式运行中的 verifier 用量标记保存在评分 stdout，Hitch 完整保留该诊断材料；Target 总用量仍按 provider 实际可观测范围报告，未知部分不补零。

无模型协议验收可设置 `GEAR_TEST_BENCHMARK_IMAGE` 为固定摘要的 Python 镜像后运行 `npm run test:benchmark:llm`。它在真实 Docker 中使用本地 HTTPS 假服务验证正例、反例、拒答和丢失响应，输出报告并确认清理；不会访问真实模型，不代表认证和实际账单已验证。
