# Hitch Local Exact Commit → Harbor Transport 开发需求

- 状态：Implemented in Hitch `dev@8c034d98f4e5142875a9ae1c41a5679b1b735f81`
- 目标仓库：`agent-hitch`
- 目标版本：0.2.x后续兼容版本
- 核查基线：`dev@eab418605726bc8ac7db3572e2638e29c551ccc7`
- 消费方：Gear / `dsh-plugin-refine`，仅通过Hitch CLI
- 日期：2026-08-21

实现核对：Hitch 已加入 exact-commit object pack、host/container 双重校验、locked resolution handoff、eval records 与回归测试。本文件保留为跨仓库合同和 Gear 集成验收依据。

## 1. 一句话需求

让现有命令：

```bash
hitch eval run \
  --backend harbor \
  --dataset <dataset> \
  --harness 'deepseek@git+file:///absolute/repo#<full-commit>' \
  --output json
```

能够在不推送该commit到远端的情况下，把host上的exact local Git commit安全、可验证地运输到Harbor trial，并继续使用Hitch现有resolver、artifact preparation、`deepseek` adapter、run engine和eval records。

## 2. 背景与当前行为

Hitch当前已经支持local Git ref用于普通resolve/prepare/run：

```text
<harness-id>@git+file:///absolute/repo#<commit>
```

`src/harness-reference.ts`解析file URL，`src/artifacts.ts`把commit解析为full OID、要求local repo clean、写入`ResolvedRevision`并用现有adapter recipe prepare。

Harbor eval目前有两个显式拒绝：

1. `validateEvalRequest()`拒绝explicit local Git ref；
2. `runEval()`拒绝`resolvedRevision.source.registered !== true`。

这个拒绝在没有transport时是正确的：Harbor container无法访问host absolute path。当前Harbor bridge只上传Hitch controller runtime，然后在container内根据locked public version/commit重新prepare；local-only commit既不在registered remote，也不能从host path读取。

## 3. 目标

实现后必须满足：

1. public CLI仍使用现有`--harness git+file://...#...`语法，不引入Gear专用命令；
2. host只接受explicit local Git source的exact full commit；
3. transported source只来自该commit，不包含worktree未提交内容；
4. Harbor内实际prepare/run的commit与host `ResolvedRevision.revision.commit`完全相同；
5. Harbor内消费host锁定的resolution identity，不以container临时路径重新定义identity；
6. 继续使用现有adapter recipe和run engine；Gear场景继续使用现有`deepseek` adapter；
7. registered remote commit、exact npm version及普通local run行为不变；
8. CLI JSON result和eval record可以证明这次eval使用了哪个commit和哪份transport payload。

## 4. 非目标

本需求不包括：

- 新增 `dsh-evolving` adapter；
- 修改DeepSeek adapter的headless process contract；
- 发布Hitch Node SDK或external adapter ABI；
- 接受任意local directory、installed executable或未提交worktree内容进入Harbor；
- 让Hitch比较baseline/candidate或做promotion；
- 导出完整native DSH session、workspace snapshot或Gear verifier sidecar；
- 允许container回连host filesystem；
- 自动push candidate到Git remote；
- 把transport digest变成新的Harness revision identity。

## 5. Public CLI合同

### 5.1 接受条件

`hitch eval run`只在以下条件全部成立时接受local Git source：

- selector为explicit `git+file://`；
- URL解析为absolute local path并通过现有canonicalization；
- fragment是full lowercase commit OID；SHA-1 repo为40 hex，未来SHA-256 repo可为64 hex；
- `git rev-parse <oid>^{commit}`返回完全相同的OID；
- repo通过Hitch现有clean-source检查；
- harness definition支持commit revision source；
- backend为Harbor。

abbreviated commit在普通local resolve中可保持兼容，但用于Harbor local transport时必须拒绝。branch、tag、`HEAD`、refname和缺失fragment均拒绝。

### 5.2 命令输出

现有`--output json`和`--output jsonl`行为保持不变：

- JSON stdout只输出最终EvalResult；
- JSONL stdout只输出eval events；
- diagnostics写stderr；
- process exit code继续等于`result.exit_code`；
- SIGINT/SIGTERM继续取消eval。

不要求增加新的public opt-in flag。用户显式提供`git+file://`就是选择local source；如Hitch维护者需要部署级policy，可增加可选allowlist，但不得成为Gear CLI的隐式、不可发现前提。

## 6. Host-side resolution与transport构建

### 6.1 Resolution authority

host继续调用现有`resolveHarness()`，并把其输出作为本次eval唯一resolution authority：

```ts
interface LockedLocalGitResolution {
  harnessId: string
  canonicalRef: string
  resolutionIdentity: string
  commit: string
  sourceUrl: string
}
```

container不能根据临时路径重新调用public resolution并产生另一个identity。尤其不能把host ref：

```text
deepseek@git+file:///path/to/repo#abc...
```

简单改写成：

```text
deepseek@git+file:///tmp/source#abc...
```

然后把后者当成新的canonical resolution，因为当前Hitch identity包含source URL，这会破坏host/container identity一致性。

### 6.2 Transport payload

Hitch在eval directory内创建content-verified transport payload。允许使用shallow Git bundle、Git object pack或source snapshot + commit/tree proof；实现形式可选，但必须提供等价保证。

建议逻辑manifest：

```ts
interface LocalGitTransportManifest {
  schema_version: '1'
  kind: 'local-git-commit'
  harness_id: string
  resolution_identity: string
  commit: string
  tree: string
  payload_sha256: `sha256:${string}`
  payload_bytes: number
  created_at: string
}
```

身份规则：

- Git commit仍是Harness version；
- `resolution_identity`仍由host现有resolver产生；
- `payload_sha256`只用于检测transport损坏或替换；
- `created_at`是描述字段，不参与payload identity。

### 6.3 Source内容

payload必须足以在离线于原始Git source的情况下materialize exact commit tree，并保留Git需要的文件mode和symlink语义。

payload不得包含：

- untracked、modified或staged-but-uncommitted文件；
- `.git/config`、credential helper配置、remote token、hooks或host绝对路径配置；
- 与materialize exact commit无关的其他refs；
- Hitch state、Gear state或用户workspace。

若选择会携带祖先history的bundle格式，必须记录并限制其范围和大小；优先使用只包含checkout exact commit所需对象的shallow transport，避免无意运输repo历史中的敏感内容。

### 6.4 Limits与原子性

transport必须：

- 在临时目录构建，完成校验后atomic promote；
- 使用owner-only权限；
- 有可配置的总字节、文件/对象数量和单文件上限；
- abort时停止构建并清理未promote临时文件；
- 已完成payload可按`resolution_identity + payload_sha256`安全复用。

## 7. Harbor JobConfig与bridge handoff

local transport存在时，`plan.json`和Harbor agent kwargs需要携带非秘密的transport元数据及host-side payload位置。字段名可由实现决定，但语义至少包括：

```ts
interface LocalGitTransportUse {
  manifestPath: string
  payloadPath: string
  resolutionIdentity: string
  commit: string
  payloadSha256: string
}
```

host绝对payload path是当前机器的backend bookkeeping，不是durable identity。持久记录使用resolution/commit/digest，不能要求其他机器通过该path解析证据。

Python `HitchHarborAgent.setup()`必须在上传前：

1. 读取并验证transport manifest schema；
2. 核对job-pinned resolution identity、commit和payload digest；
3. 重新hash payload；
4. 拒绝missing、mismatch、oversize和非普通文件；
5. 上传到trial私有路径；
6. 不把host Git credential或repo path作为container dependency。

该流程可以复用现有controller runtime upload的“manifest + digest + upload前重验”设计，但local source与controller runtime必须保持独立manifest和identity。

## 8. Container-side materialization

trial内必须：

1. 再次验证transport manifest和payload digest；
2. materialize一个trial-private Git source/cache；
3. 验证commit object/OID；
4. 验证materialized tree等于manifest中的tree；
5. checkout detached exact commit；
6. 将该source与host锁定的`ResolvedRevision`一起交给现有`prepareGitArtifact()`语义；
7. 使用现有prepared artifact和adapter执行Hitch run。

关键不变量：

```text
host resolved commit
  == transport manifest commit
  == materialized commit
  == prepared artifact resolved_revision.commit
  == Hitch run result revision_identity所引用的commit
```

container不得为了candidate source访问host file URL或registered remote。adapter recipe自身安装依赖所需的网络行为保持现状，不属于本需求；这里禁止的是重新获取Git candidate source。

### 8.1 Internal locked-resolution seam

当前Harbor bridge在container内调用public `hitch prepare <locked-ref>`和`hitch run --harness <locked-ref>`，它们会重新resolve。local transport需要一个内部、非用户可控的seam，让prepare/run消费：

- host写入的locked `ResolvedRevision`；
- 已验证的container-local Git source/cache；
- 对应transport manifest。

可以实现为internal CLI flags、私有bootstrap manifest或预填充的verified source cache。无论选择哪种方式，都必须：

- 由Harbor bridge设置，不能由candidate或task prompt覆盖；
- 在prepare和run两处使用同一locked resolution；
- 拒绝harness id、commit、resolution identity或source tree不一致；
- 不暴露为可以绕过普通CLI校验的通用不安全入口；
- 在eval record中留下可审计引用。

本需求不预设具体私有flag名称；实现PR必须在代码和测试中明确其authority boundary。

## 9. Eval records

`request.json`和`resolution.json`继续保持现有语义。`plan.json`至少新增可选字段：

```ts
local_source_transport?: {
  kind: 'local-git-commit'
  resolution_identity: string
  commit: string
  tree: string
  payload_sha256: string
  payload_bytes: number
}
```

最终`result.json.candidate`必须继续包含host锁定的harness ref和revision identity。可附加相同transport摘要，但不得只返回container临时路径。

JSONL建议新增事件：

```text
eval.local-source.prepared
eval.local-source.uploaded
eval.local-source.verified
```

事件只含commit、identity、digest、bytes和状态，不输出host credential、Git config或payload内容。

## 10. 失败语义

建议错误码：

| 情况 | 建议code | 结果 |
| --- | --- | --- |
| local eval使用abbreviated/refname | `invalid_input` | eval failed，Harbor不启动 |
| local repo dirty | 保持 `dirty_source` | eval failed，Harbor不启动 |
| transport构建/读取失败 | `local_source_transport_failed` | eval failed |
| payload/manifest/commit/tree不一致 | `local_source_integrity_mismatch` | eval failed |
| container materialize失败 | `local_source_materialize_failed` | eval failed |
| existing adapter prepare失败 | 保持 `prepare_failed` | eval failed |

任何transport failure都是基础设施失败，不能生成可比较的零reward trial。错误message要包含阶段和非秘密diagnostic，不能输出credential或payload内容。

## 11. 安全要求

- source path来自显式CLI参数并在host canonicalize；禁止NUL、控制字符和path escape；
- Harbor config/bridge使用argv或严格shell quoting；candidate不能注入command fragments；
- 上传前和container内各校验一次payload；
- 不执行host worktree文件、Git hooks或candidate脚本来构建transport；
- prepare阶段继续遵循该adapter现有recipe；candidate执行发生在Harbor trial，不回落到host；
- transport目录和container source目录不是task workspace，不向agent prompt暴露；
- Harbor cleanup和abort后删除trial-private source；
- logs不记录Git credential、environment secret或source内容。

## 12. 兼容性

必须保持：

- registered `@commit:` Harbor eval原行为和records；
- exact `@version:` Harbor eval原行为；
- `@installed`继续被eval拒绝；
- 普通local resolve/prepare/run语义；
- controller runtime identity/cache；
- Harbor credential forwarding、timeouts和cancel；
- `hitch eval list/inspect`读取旧record；旧record没有`local_source_transport`时正常工作。

该能力最好对所有具有Git commit revision source的adapter通用；验收至少覆盖现有`deepseek` adapter。

## 13. 测试要求

### 13.1 Unit / contract

- full local commit被eval validator接受；
- 7位或其他abbreviated commit被eval拒绝；
- branch/tag/HEAD被拒绝；
- dirty repo保持拒绝；
- transport manifest canonical validation；
- payload tamper、manifest tamper、commit mismatch、tree mismatch分别失败；
- host path含空格和Unicode时仍正确运输，且无shell injection；
- untracked/host Git config/credentials不进入payload；
- size/object/file limits生效；
- abort清理临时transport。

### 13.2 Harbor bridge

- fake environment观察到controller runtime和local source分别上传；
- bridge在upload前重新hash；
- job-pinned identity mismatch在执行Hitch前失败；
- container使用transport source而非host file URL；
- Git source network被测试shim禁止时仍能prepare exact local commit；
- container内actual commit/tree与host一致；
- Hitch run result revision identity与host plan一致。

### 13.3 Regression

- registered remote commit eval仍通过；
- npm version eval仍通过；
- local ordinary run仍通过；
- eval list/inspect兼容新旧records；
- controller runtime cache tests不受影响；
- Node 22/24、Linux/macOS host测试矩阵通过；Harbor container至少覆盖Linux。

### 13.4 End-to-end acceptance

创建一个clean local DSH repo commit，该commit不存在于registered remote；使用现有`deepseek` adapter运行一个最小Harbor dataset：

1. `hitch eval run ... --harness deepseek@git+file://...#<full-commit> --output json`退出0；
2. result `status === "succeeded"`且存在finite primary reward；
3. `resolution.json.revision.commit`等于请求commit；
4. `plan.local_source_transport.commit`和digest存在；
5. trial内Hitch result的revision identity等于host plan；
6. host repo临时不可达或container禁止访问original remote时trial仍成功；
7. 篡改transport后同一流程在运行candidate前fail closed。

## 14. Definition of Done

- public CLI示例可在真实Harbor环境运行；
-所有第13节测试通过；
- docs/evals.md、CLI help和README说明local exact commit的可移植性与限制；
- machine record schema和runtime validation同步更新；
- release package包含Harbor bridge所需代码；
- 没有新增adapter、Gear依赖或Node public API；
- PR说明internal locked-resolution seam及其不可被candidate控制的证据。

## 15. 代码定位

预计涉及但不限于：

- `src/harness-reference.ts` — eval-only full commit约束复用；
- `src/artifacts.ts` — locked resolution与verified local source prepare seam；
- `src/evals.ts` — 接受eligible local ref、构建transport、写plan/result/events；
- `src/harbor-backend.ts` — JobConfig transport metadata；
- `integrations/harbor/hitch_harbor_agent.py` — upload、container verify/materialize、locked handoff；
- `src/cli.ts` — help文案；public command形状原则上不变；
- `docs/evals.md`和schemas；
- `test/evals.test.ts`、artifact/bridge smoke与新增transport tests。

## 16. 上游设计约束

该需求遵守Hitch现有产品边界：

```text
resolve -> prepare -> run -> report
```

Gear负责创建commit、选择H0/H1、比较reward和promotion；Hitch只让一个已经明确选择的local immutable revision具备Harbor可达性。运输层不得演变成第二套Harness版本系统。
