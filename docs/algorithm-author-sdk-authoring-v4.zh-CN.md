# Gear 作者合同与完整项目 v4（待实现规格）

本文是 [v4 实现方案](algorithm-author-sdk-plan-v4.zh-CN.md) 的规范性附件。全部新增 API/命令是实施目标，当前 `gear-algorithm`/`rsi-gear` 版本不能直接运行这些样例。A0 固定其机器可校验 schema，A1 将下列文件做成安装后可运行的仓库外项目；每次改动本文的合同都需要对应验收。一个科学算法任选 Python 或 TS，下面两份实现仅为验证 SDK 的同等表达能力，不要求作者维护两份。

## 1. 作者可依赖的执行规则

| 写法 | 合同与替代方式 |
| --- | --- |
| 局部变量、短循环、分支、纯函数 | 从冻结输入与历史结果确定地重放；不能依赖上一次 worker 留下的全局变量 |
| `await ctx.evaluate/propose/role/operation/...` | 惰性受管理调用；提交意图后才有外部效果；失败和恢复沿原操作身份 |
| `ctx.parallel([call1, call2])` | 调用构造时不启动；返回按声明顺序排列的 `Outcome[T]`，每项为 `{ok: true, value}` 或 `{ok: false, error}`；unknown 保持运行未决，不返回为普通 error |
| 自定义并行子函数 | Python `@workflow`、TS `workflow(fn)` 包装普通 async 函数，调用返回 ManagedCall；参数与返回值必须可序列化/typed refs，ctx 由框架注入为该分支作用域 |
| `await` 同一个 ManagedCall 两次 | 报重复消费；先 await 一次，把返回值存在局部变量中复用 |
| `time.time` / `Date.now` / 预算读盘 | 决策用 `await ctx.now()` / `await ctx.budget()`，观察经 author.observe 持久化 |
| 需要新随机 seed / 新业务 ID | `await ctx.random_seed()` / `await ctx.new_id()`，同属 author.observe 的明确类型；值在意图输入冻结，重放不重新采样；不是作者提供 operationId 的入口 |
| 固定 seed 的 random/NumPy 等纯计算 | seed 放在冻结 config；每次从相同 seed 和输入重建，固定库版本与调用顺序。不同分支使用独立 seed/局部状态，不共享全局 RNG，不声称 GPU 非确定算子因此可精确重放 |
| 文件、环境、prompt、数据集 | 可变来源由 RunSpec/profile 在 run 前解析并封存为 refs；worker 只读输入快照。不能每次重放重新读取原可变文件或环境来决定策略 |
| 直接 LLM SDK、HTTP、数据库写、GPU 作业 | 放进有生命周期的 provider，经 ctx.operation 或现成 typed wrapper 调用；裸调用不属于支持的可恢复用法 |
| Optuna 等有状态第三方库 | 使用保留 sampler/study checkpoint 的 provider adapter；不能在每次 replay 修改同一个活 study；已有适配能力可复用但新接线仍验收 |
| Promise.all / asyncio.gather/create_task | 不用于调度 Gear 步骤；使用 ctx.parallel。普通非 Gear async 的任意 await 不在首期支持范围 |
| try/except/catch | 可处理已封存业务错误；不能捕获基础设施 unknown 后发起替代副作用。基础设施未决由 controller/provider 处理 |
| finally / with / dispose | 仅本地计算资源；模型会话、训练作业和远端资源的释放由 provider cancel/collect 合同负责，不能依赖 worker 析构 |

轻量 workflow 没有独立 resume ID、嵌套账本或可持久堆；其路径与步骤属于同一 Campaign。首期不支持最快完成者竞争、后台未等待任务或单独重启一个子函数。执行前静态检查与能拦截的运行时检查会标明错误文件/行号，但不保证发现第三方库深处所有 IO，也不是恶意代码沙箱。可靠性以作者遵守合同为前提。

A0 必须在 Python/TS 中分别用作者自定义 workflow（至少两个受管理 await）参加嵌套 parallel，核验包装函数构造不会执行函数体或启动 IO、参数/只读捕获冻结、分支独立和强停后地址/原 key 稳定；不能只测内置复合 API。空 `ctx.parallel([])` 返回空 outcomes，不产生新的前沿/操作；重复消费仍按上表报错。

分支不可共享可变列表、PRNG、计数器或其他状态来通信；可以捕获已冻结常量/只读 refs，合并在 join 返回后进行。定义版本、输入与 logical address 的历史匹配必须在新意图提交前完成。对允许的业务失败，顺序 await 可抛出可重放的 typed error，parallel 会收集该错误；已完成 Evaluation 的 invalid/不完整状态是数据状态，不是 fabricated error/零分。

## 2. 管理员一次性准备和 profile

前置条件是一个正常工作的 Gear/Hitch 安装，有实际模型目的地、Harness Git 仓库、编译任务集和所需凭据。Hitch 的正式依赖和能力/版本检查保留。A1 必须提供内置的 `local-harness` profile 模板和模型/编辑/Hitch 服务装配器；没有这些实现，不能让作者自己写 host.mjs 后宣称易用性通过。

拟实现的管理员入口：

```sh
gear profile init lab --template local-harness --from-runtime-config /srv/lab/gear-runtime.yaml
gear profile check lab
```

`gear-runtime.yaml` 表示管理员已有部署配置的导出/映射输入，不是假定现有文件格式已经支持本命令。A0 固定该输入 schema，A1 提供从当前 Gear/Hitch 配置读取的适配器；缺字段时 init 明确列出待填项。下面是 init 产出的**可编辑 profile 全部用户字段**示例，resolved digest、端口注册、凭据值和依赖图由工具生成：

```yaml
schemaVersion: 1
id: lab
template: local-harness
runtimeConfig: /srv/lab/gear-runtime.yaml
workspace:
  repository: /srv/lab/agent
  harnessRoot: harness
  stateRoot: /srv/lab/gear-state
hitch:
  executable: /opt/hitch/bin/hitch
  storageConfig: /srv/lab/hitch.yaml
models:
  meta: lab-meta
  target: lab-target
inputs:
  initialAgent: {gitRef: main}
  searchTasks: {compiledDataset: /srv/lab/tasks/search, purpose: development}
roleTemplates: [harness-editor, read-only-analyst]
editing:
  allowedPaths: [harness/**]
  maxFiles: 20
  maxBytes: 262144
  maxDiffBytes: 131072
evaluation:
  metric: pass_rate
  passThreshold: 1
  requireAllTrialsValid: true
operationLimits:
  modelRequests: 4
  modelTokens: 20000
  timeoutMs: 120000
budgetDefaults:
  modelRequests: 100
  modelTokens: 500000
  rolloutTrials: 200
```

`lab-meta/lab-target` 必须解析到 runtimeConfig 中已有、可用的模型注册与凭据引用；init 不能虚构或自动购买目的地。runtimeConfig 还需含执行环境、Harness 构建/任务编译服务、目标运行配置、采样和资源设置；init 将实际采用字段列入 explain 并冻结。上述预算字段通过内置服务的计量来源映射到 Campaign 维度，不能仅作为忽略的显示值。若现有安装有私有模型插件，其一次性安装由管理员完成；普通算法不新增 TS 服务接线。

profile 的文件路径/别名在 run 时解析为精确内容和身份：`main` → Git commit/tree，任务目录 → dataset/task digest，模型别名 → 实际 provider/model/目的地，Hitch → 可执行版本/能力与存储定位，运行环境/采样 → 实际支持的冻结配置。生成 `run.lock.json` 后恢复使用 lock，配置漂移明确报错。`profile check` 拒绝不受支持数据集或采样配置，不静默退化。

此配置是一次性管理员成本，必须单独计时；算法作者的 30 分钟目标从已通过 profile check 的环境开始，不能据此宣称裸机到 GPU 训练 30 分钟完成。

## 3. 完整 Python 作者项目

作者新增五个文件：`algorithm.py`、`run.yaml`、`roles.yaml`、`prompts/optimizer.md`、`requirements.txt`。`gear algorithm init demo --language python --template search --profile lab` 生成它们；不存在隐藏的 host.mjs、provider、手写 manifest 或 digest。

`requirements.txt`：

```text
gear-algorithm==<本次发布的确切版本>
```

这里的版本占位符由 init 自动填成与宿主兼容的 SDK 发布版本，验收时必须是真实可安装版本或测试 wheel 的确切版本，不允许保留占位符。算法额外依赖由作者添加，安装 lock/环境身份由 check/run 冻结。

`run.yaml`：

```yaml
schemaVersion: 2
algorithm: {language: python, module: ./algorithm.py, export: search}
profile: lab
roles: ./roles.yaml
inputs:
  initialAgent: {profileAlias: initialAgent}
  searchTasks: {profileAlias: searchTasks}
config:
  rounds: 3
  taskCount: 10
  proposalCount: 4
  seed: 42
```

`roles.yaml`：

```yaml
schemaVersion: 1
roles:
  optimizer:
    template: harness-editor
    prompt: ./prompts/optimizer.md
    inputSchema: sdk:harness-edit-input.v1
    resultSchema: sdk:harness-edit-result.v1
```

模板声明其允许的基础能力；inputSchema 是 base Agent 引用、授权 feedback 引用和候选序号；resultSchema 是 change summary 与变更状态等结构化元数据，不允许模型声称一个 digest 就变成 Agent。harness-editor 获得 profile 允许范围内的 workspace edit 端口，实际 Git 文件由受管理编辑会话修改，构建/边界验证及 binding 派生由 SDK 子流程完成。只读角色换成 read-only-analyst，并使用其结构化结果 schema；不因角色名字改变文件权限。

`prompts/optimizer.md`：

```text
根据提供的任务反馈改进当前 Harness。
先定位失败原因，再在允许的文件范围内完成一次有明确假设的修改。
保留原有任务接口。按模板要求返回修改摘要和依据。
```

`algorithm.py`：

```python
from gear_algorithm.author import algorithm

@algorithm
async def search(ctx):
    best = ctx.initial_agent
    tasks = await ctx.tasks.sample(
        ctx.data.search_tasks, count=ctx.config.taskCount,
        seed=ctx.config.seed,
    )
    archive = []
    for round_index in range(ctx.config.rounds):
        baseline = await ctx.evaluate(best, tasks=tasks)
        if not baseline.comparable:
            await ctx.checkpoint("baseline-incomplete", baseline)
            return ctx.result(outputs={"incomplete": baseline})

        proposed = await ctx.propose(
            best, feedback=baseline, role="optimizer",
            count=ctx.config.proposalCount,
        )
        settled = await ctx.parallel([
            ctx.evaluate(candidate, tasks=tasks)
            for candidate in proposed.candidates
        ])
        measured = [item.value for item in settled if item.ok]
        best = ctx.select(
            [baseline, *measured], metric="pass_rate",
            require_improvement=True,
        ).agent
        archive.append({
            "round": round_index,
            "baseline": baseline,
            "proposals": proposed,
            "evaluations": settled,
            "selected": best,
        })
        await ctx.checkpoint("population", archive)

    return ctx.result(selected=best, outputs={"population": archive})
```

`ctx.config` 将 YAML 配置键映射为只读对象；例子的 config schema 由 search 模板提供，正整数/预算范围在运行前校验，用户无需手写。自定义配置可以在算法声明或包内 schema 文件指定；CLI 自动生成和封存 manifest。`searchTasks` 是 RunSpec 字段，Python SDK 对应 `ctx.data.search_tasks`，TS 对应 `ctx.data.searchTasks`，wire 统一。

`propose` 返回 `ProposalBatch(candidates, failures)`；后者保留失败阶段/原因/证据，不保证指定 count 个候选全部成功。每个 candidate 都是可执行且不可变的 HarnessAgent。`evaluate` 返回含 subject、逐任务状态、evidence、condition、comparable 和可用 metrics 的 Evaluation；默认 select 排除不可比较项并保留失败记录在 archive。条件不同的 complete 测量不会悄悄忽略或混排，而是明确报不可比较。若全无合法候选，例子保留有效 baseline。没有有效 baseline 时例子发布 incomplete 输出并正常结束，不将其解释为搜索成功或评分为零。

例子每轮的 checkpoint("population", archive) 在根 workflow 作用域中产生一个新的不可变版本；同一步重放复用原 ref，inspect 可以查看所有已提交版本和最近版本。并行子 workflow 的同名 checkpoint 位于各自作用域；不按名称覆盖。终态 outputs.population 封存的是此处显式传入的完整 archive，或作者显式传入的 checkpoint ref，不是恢复时动态解析的“最新 population”。

checkpoint 默认使用内置 `author.archive.v1`；它仅序列化 JSON 和已支持 typed refs，并列出引用边，不能序列化任意 Python 对象。普通作者不写 schema；自定义领域类型要用显式 serializer/schema 并在 check 时验证其引用边，不额外批准权限。返回 outputs 接受相同数据类型，runner 在终态决定前写入不可变制品，再原子发布清单。

安装与运行的目标命令：

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
gear algorithm check run.yaml --python .venv/bin/python
gear algorithm explain run.yaml --python .venv/bin/python
gear algorithm run run.yaml --python .venv/bin/python
gear algorithm resume <明确的-run-id>
```

run 创建 campaign ID、run lock 和 `.gear` 目录，不让作者手填 operationId/state schema。run 默认跟随异步操作，正常 waiting 不要求作者反复执行 resume。业务未决状态给出对应 run/operation 的原因；退出观察不等于取消远端作业。

## 4. TypeScript 替代项目及 explain

同一算法选 TS 时，保留上述 roles.yaml 和 prompt；将 run.yaml 的 algorithm 改为 `{language: typescript, module: ./algorithm.ts, export: search}`。用 package.json 代替 requirements.txt，因此同样是五个作者文件。依赖 `rsi-gear` 使用 init 写入的精确发布版本，package manager 生成 lock；TS loader 由 Gear 提供，不要求作者手建 tsconfig/编译宿主。

```json
{
  "private": true,
  "type": "module",
  "dependencies": { "rsi-gear": "<本次发布的确切版本>" }
}
```

```typescript
import { algorithm, type SearchConfig, type SearchRoundRecord } from "rsi-gear/algorithm/author";

export const search = algorithm<SearchConfig>(async (ctx) => {
  let best = ctx.initialAgent;
  const tasks = await ctx.tasks.sample(ctx.data.searchTasks, {
    count: ctx.config.taskCount, seed: ctx.config.seed,
  });
  const archive: SearchRoundRecord[] = [];
  for (let round = 0; round < ctx.config.rounds; round++) {
    const baseline = await ctx.evaluate(best, { tasks });
    if (!baseline.comparable) {
      await ctx.checkpoint("baseline-incomplete", baseline);
      return ctx.result({ outputs: { incomplete: baseline } });
    }
    const proposals = await ctx.propose(best, {
      feedback: baseline, role: "optimizer", count: ctx.config.proposalCount,
    });
    const evaluations = await ctx.parallel(
      proposals.candidates.map(candidate => ctx.evaluate(candidate, { tasks })),
    );
    const measured = evaluations.flatMap(item => item.ok ? [item.value] : []);
    best = ctx.select([baseline, ...measured], {
      metric: "pass_rate", requireImprovement: true,
    }).agent;
    archive.push({ round, baseline, proposals, evaluations, selected: best });
    await ctx.checkpoint("population", archive);
  }
  return ctx.result({ selected: best, outputs: { population: archive } });
});
```

`SearchConfig/SearchRoundRecord` 是 search 模板的 SDK 类型；不是所有算法必须采用的领域模型。Python/TS 的类命名和 snake/camel API 映射由各 SDK 负责，共享 JSON refs/outcomes/输入含义，不要求随机算法在两语言重写。

`explain` 的目标输出示意（实际值必须由已解析的配置填入，不能仅照抄此列表）：

```text
algorithm: ./algorithm.py:search → frozen source + environment
profile: lab → template local-harness
models: meta lab-meta → actual provider/model; target lab-target → actual provider/model
initialAgent: main → exact Git commit/tree + harness binding
searchTasks: development → exact dataset/task identities, no final-test use
optimizer: harness-editor → ./prompts/optimizer.md, SDK input/result schema
write scope: harness/**, maxFiles 20, maxBytes 262144, maxDiffBytes 131072
propose: workspace-edit → build/validate → bindings.derive; failed edits remain outcomes
evaluate: tasks.consume → rollout → feedback/measurement; invalid trials stay invalid
budget: requested/default limits → actual provider sources, reservation units
outputs: author.archive.v1 → automatic typed-ref dependency graph
F/O/J: static estimate where possible; otherwise dynamic/unknown, frozen runtime limits
Hitch: resolved executable/version/capabilities/storage; environment/sampling resolved
```

## 5. 两个扩展场景与诊断

普通作者增加一个只读诊断角色，只新增角色条目、prompt/业务 schema 并调用 `await ctx.role("diagnoser", input)`；profile 已批准 read-only-analyst 时无须管理员按新角色名审批。若需要新的文件可见范围、工具或模型目的地，管理员修改能力配置；prompt 或 schema 变化本身不扩权。

后端开发者安装外部 provider 包，profile 声明其版本、kind、预算和权限；作者调用 `await ctx.operation("my-metric.compute", input)` 或包提供的 typed wrapper。这个调用与 built-in 同样惰性、可组合和受管理。A1 必须分别验证 Python provider/TS caller 和 TS provider/Python caller，不改核心注册表。provider 的 schema、资源恢复与证据验证是扩展包责任，单纯有 schema 不能把它变成受信评分器。

历史起点只需将 run.yaml 的 initialAgent 替换成一个经 history inspect/import 识别的 source/candidate selector。CLI 展示原记录、可读轨迹、可执行起点各自状态；Hitch 轨迹继续通过标准接口取得。默认不要求作者了解旧 JSON 格式或手工造 ref。先导入明确候选并生成新 run，不恢复旧 pending job。

| 典型失败 | CLI/SDK 应给出的操作信息 |
| --- | --- |
| 非受管理随机/IO 或裸并发 | 文件、行号、检测到的操作、适用的受管理 API；仅覆盖明确声明能检测的情形 |
| role 模板不允许写文件 | 角色名、实际模板、请求与允许范围；可改为已有 editor 模板或由管理员调整 profile |
| schema/配置不符 | 文件、字段路径、期望类型/范围；运行前失败，不等调用模型后才报错 |
| 重放输入变化 | logical address、旧/新输入摘要与来源位置；不创建新副作用，不静默重新开始 |
| historical candidate 只有 SHA | candidate-object-missing 与来源定位；仍可查看报告，不能作为 Agent |
| unknown 物理调用 | run ID/operation ID、provider 状态、可用 inspect/reconcile 入口；不自动换 key |
| 前沿/预算上限 | 当前 F/O/J、冻结限额、已提交步骤及最近 checkpoint；保存未完成状态 |

上述体验在 A1 即由未参与实现者试用，再在 A3 收敛后复验；记录作者手改文件数、初始化生成文件数、管理员一次性设置、每个算法新增宿主代码数、第一次失败和解决耗时。目标不是“一个函数看起来很短”，而是完整路径不要求修改 Gear 核心或为每个算法写宿主。
