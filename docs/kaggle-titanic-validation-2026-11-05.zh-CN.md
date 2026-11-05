# Titanic 真实模型验证：2026-11-05

本次已完成真实 Titanic 数据与真实 Meta/Target 模型的基线、两个候选五折比较、promotion holdout、全量训练和 CSV 导出。C0 已晋升，最终 418 行预测通过独立格式与 ID 校验。最终公开快照时间为 2026-11-05 09:00:02 UTC。本记录不含 Kaggle 线上提交或排行榜分数，也不代表多代候选继承已验证。

## 结果

每个版本都在相同的五个 development folds 上评估，以下为 verifier 原始 accuracy；15 个 CV 单元均 certified，valid_output 均为 1。均值是五折等权平均，不是 pooled OOF accuracy。

| 版本 | Fold 0 | Fold 1 | Fold 2 | Fold 3 | Fold 4 | Mean-fold accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 84.615385% | 82.517483% | 81.118881% | 83.916084% | 74.468085% | 81.327183% |
| C0 | 85.314685% | 84.615385% | 81.818182% | 79.720280% | 80.851064% | 82.463919% |
| C1 | 82.517483% | 83.916084% | 82.517483% | 78.321678% | 81.560284% | 81.766602% |

Baseline 使用 LogisticRegression（C=1、max_iter=1000）。C0 使用 500 棵树的 RandomForest（max_depth=6、min_samples_leaf=2）；C1 为 500 棵树、depth=7、leaf=3。两个候选都保留训练折内拟合预处理、seed=42、n_jobs=1；max_features 都被 pipeline 转为 float 1.0。改动限于获准的 Python pipeline 和 model.json。

| 晋升比较 | 正确数 / 样本数 | Accuracy | 结论 |
| --- | ---: | ---: | --- |
| Baseline holdout | 137 / 178 | 76.966292% | 对照 |
| C0 holdout | 141 / 178 | 79.213483% | accepted，championChanged=true |
| C1 holdout | 未评估 | — | 未成为 nominee |

C0 的 CV 比基线高 1.136736 个百分点，holdout 高 2.247191 个百分点。冻结目标为 total_score，约束 valid_output≥1；晋升记录的 objectiveGain 为 0.02247191。没有凭这个单次分割宣称统计显著性或排行榜收益。promotion holdout 已参与选优，不是未接触的最终测试集。

## 数据、模型与运行版本

- 891 条有标签训练样本按 seed=42 划为 713 条 development、178 条 holdout；五折验证行数为 143/143/143/143/141。最终任务已实际用全部 891 条训练样本预测 418 条 test。
- 官方无凭据下载返回 HTTP 401，因此采用固定 commit 的公开镜像，并与另一个固定镜像逐表头、逐单元格交叉验证一致；不是经 Kaggle 登录下载的字节。主镜像为 minsuk-heo/kaggle-titanic 的 `96c14e776090f7919d15064ed73e3b2788b4288c`，交叉镜像为 hhnks/Titanic-ML-Competition 的 `38d0f7909c0d8d30a2d26548444f5c6e7367d0ed`。sample submission 是示例预测，不是真值；没有获取 test 标签。
- Gear 运行修复版本：`83ac577e70c826cd4197aaee133834910d39a0de`；Hitch：`3aee047ad4d87e4b621f19dd4ad77dd59313c952`。
- 真实 Meta：`openai-codex/gpt-6-astra`，reasoning effort=medium，Codex 0.154.0-alpha.6.2。真实 Target：`openai-codex/gpt-5.6-luna`，DSH native session 通过固定 run_pipeline 执行训练；每任务一次 attempt。
- 本机 Docker 27.4、Harbor 0.21.0、linux/arm64；Target 镜像为 Node 22.23.0、Python 3.11、NumPy 1.26.4、pandas 2.2.3、scikit-learn 1.5.2。数据/receipt 保护、chroot、独立 UID、seccomp 及 Meta 宿主边界经过实际探针检查。
- 宿主实际使用 Node 23.11.0，超出 Gear 声明的 Node 22.19+（22.x）或 24+ engine 范围；本次成功不等于承诺支持 Node 23。复现应按受支持的宿主版本执行，Target 的固定 Node 22 镜像不受此差异影响。

| 输入 / 运行身份 | SHA-256 |
| --- | --- |
| train.csv | `7d118fef8b6ccf7f81111877bc388536f7b1e498a655e3d649d19aaa010e9f6f` |
| test.csv | `56023b9948236f3c7a1c9448fcf418b283e109ef177fa8c7e069158dd7dd52b2` |
| gender_submission.csv | `7a262a7f4cb807f53911dccc84257ed3976b21b7b50ffc468b58446bff8bb6a4` |
| OCI linux/arm64 平台 manifest | `6965b4ceca603f9fe9b0fd00a46bcfe8b684c2052bea79ae08a57ace0dcc7e14` |
| seed dataset | `30991d195875f1ad518a332a50130326c973b9372ecfbb163386c4e75327600c` |
| holdout dataset | `0ee91bde142866af07b91b54aeaa6aa2ef0b6b2a3bad068acf21b448ccd3ff9a` |
| finalization dataset | `da2caf39e84f8884ec3da7e518b4815528e9bc495b82c07983ea3a0579cc5a2b` |

镜像通过专属 localhost registry 及 Hitch 生产 resource provider 解析后按 cache-only 使用，未推送公共镜像仓库。

## 可追溯身份

Evolution：`a572e3f8-fdbd-43a9-a2c9-ff64fde930a4`；accepted round：`469ecc8b-df32-42a5-a958-5138fecb41ae`。

| 版本 | 精确 commit | manifest digest |
| --- | --- | --- |
| Baseline | `ad9c6a82ec6cd4cad74d9e3692498a08c6a6bfeb` | `sha256:f9518d406a8255e83b8d9a6a41f35ab34cc32f00304c2d1052eb06e37c6ab6c8` |
| C0 | `8bba41331faa2e4ed5bcd7eb715300f4f18204fa` | `sha256:dd29e260633250b37bfd926db84933eb4d8d00e86ac353d98b9d71c6d574de41` |
| C1 | `9ea66566f8720e207195a7835ac5bcfa4711774c` | `sha256:0c80097985cefd0691342f5ad1934143b199590cb855afb8f233e02a82517ec8` |

| 执行 | eval ID |
| --- | --- |
| Baseline CV | `eval_a3b8beb0ec5448b0a035a98e852ed1a8` |
| C0 CV | `eval_dca361305d304229b7bc3e6982275d13` |
| C1 CV | `eval_2846d4a2fde04d17aa81f9efef82e084` |
| Baseline holdout | `eval_f1848d9205f3406bbd712a42800d2ba0` |
| C0 holdout | `eval_c96fd7930c304f3981190902a2f51408` |

两个候选都直接继承同一个 baseline commit；本次没有验证多代候选继承。完整本地证据保存在 `tmp/kaggle-e2e-20261105/`：`data/provenance.json`、`run-plan.json`、`runtime/resource-preflight.json`、`logs/search-status.json` 和 `public-report/{report.json,trials.tsv,folds.md}`。公开报告由 Gear control.status、Hitch eval/run/verifier inspect 与 runs artifacts API 生成；其错误列表保留早期基础设施失败 run 无法导出产物的事实，不混入上述 certified 分数。

## 运行中发现并修复的问题

| 问题 | 处理与结果 |
| --- | --- |
| workspaceRoot 不存在；Skill 不支持默认聚合 generation counters | 启动前创建目录，移除不支持的默认 token/request 总预算，保留时间/rollout 限额。原未启动 reserved eval 先经公开查询确认。 |
| v2 selection JSON 被当作旧 dataset 目录 | Hitch 导入报 ENOTDIR，原 eval `eval_e64cfd8b73734c12b2aa6582b24bce5a` 的五条结果均为 infrastructure invalid。修复并走公开修复流程，重新得到 certified baseline；不把基础设施失败记为模型零分。 |
| 组合基线的 verifier 来源错误 | 共享 Skill reader 误将 StageResult digest 与物理 eval ID 比较，导致 Meta decline；改为按 evolution 解析封存来源，保持 eval/trial/attempt 严格校验。 |
| 通用任务语义与 macOS 编译器环境 | 添加明确授权预测 pipeline 优化的可选任务上下文；/usr/bin/git 的 xcode-select shim 被 sandbox 拒绝后，解析 native Git 并给精确读取许可。固定 checker 的 required sandbox preflight 通过，原失败尝试保留。 |

这些修复没有更改数据划分、目标或晋升门槛；没有重置已消费尝试、伪造成功轨迹或将预检称为真实模型评估。

## 最终训练与 CSV

C0 的精确 commit 和 manifest 被独立 finalization 固定，实际使用全部 891 条有标签数据训练并预测 418 条 test。独立检查确认冻结 task 的 train_ids 与原始训练集全部 891 个 ID 顺序一致，receipt 的输入摘要及 task_digest 与冻结计划一致。`finalization.json` 状态为 complete；通过公开 `runs artifacts` 接口导出，不读取 Hitch 私有 run 目录。受信 receipt 为 completed、exit_code=0、seed=42，commit 与预测摘要均匹配输出 manifest。

| 最终产物身份 | 值 |
| --- | --- |
| eval ID | `eval_a2de24855852408691b7e8bb57022752` |
| run ID | `run_75187c60d3444d48812249ab0c1407b0` |
| 输出 manifest digest | `sha256:a5f85f11172b9fca7e0df465d9e2905c8040b78320bf107c1a2e8d2ac749b2ec` |
| submission.csv SHA-256 | `sha256:88b3e60545b6d241b7e431e3a06a5d49bf97b75bb895523a2b15e84b74096d55` |
| receipt SHA-256 | `sha256:3c4a770c0ee5303322fa924ff0762b5bc5db6cb60c5f349ef6db88da42a1b311` |
| pipeline digest | `sha256:9ad61c29f1056b67d084ab63d00ec72a0d57d8bc6dfcf97f159dc6b39cf5dac2` |

独立校验确认：418 行；恰好 `PassengerId,Survived` 两列；PassengerId 唯一、集合和顺序均与 test 一致；预测只含 0/1，分别为 283/135 条。CSV 字节摘要与 receipt/manifest/finalization 记录一致。验证文件为 `tmp/kaggle-e2e-20261105/finalization/independent-verification.json`，CSV 为同目录 `submission.csv`。producer 渲染后任务输入的字节摘要单独保存在 receipt 中，不与上表原始 CSV 摘要混用。

最终 test 无标签，本次验证没有 test accuracy。未调用 Kaggle 提交接口，未取得线上分数。

## 复现与证据导出

从新环境复现需按 [Titanic 示例](../examples/kaggle-titanic/README.zh-CN.md) 准备同一份 CSV、固定镜像、模型身份及隔离配置；运行前完成能力、编译器 sandbox 和真实 SKILL preflight。任务上下文使用示例中的 `GEAR_META_TASK_CONTEXT_FILE`。真实模型生成与平台迁移不保证产生同一个候选或字节相同的结果。

本次结束后，专用 Gear Core 与本地 registry 容器 `gear-kaggle-registry-20261105` 均已停止；实验状态、资源缓存、本地镜像和该容器保留。直接查看现有报告和 CSV 不需要恢复服务；新的镜像构建可先执行 `docker start gear-kaggle-registry-20261105` 恢复原 localhost transport。

重新生成 snapshot 需要原 Gear Core socket 在线。先在独立终端恢复已有配置与状态，不重新调用示例 start.mjs 登记新 evolution：

```sh
TITANIC_EXPERIMENT_ROOT="$PWD/tmp/kaggle-e2e-20261105"
node "$TITANIC_EXPERIMENT_ROOT/with-runtime.mjs" node lib/cli.js serve \
  --config "$TITANIC_EXPERIMENT_ROOT/project/gear.config.json"
```

下面命令使用已选定的精确 commit。相同 finalization 输入会查询并恢复原记录，不另起训练：

```sh
TITANIC_EXPERIMENT_ROOT="$PWD/tmp/kaggle-e2e-20261105"
node "$TITANIC_EXPERIMENT_ROOT/with-runtime.mjs" node examples/kaggle-titanic/finalize.mjs \
  --project "$TITANIC_EXPERIMENT_ROOT/project" \
  --commit 8bba41331faa2e4ed5bcd7eb715300f4f18204fa \
  --manifest-digest sha256:dd29e260633250b37bfd926db84933eb4d8d00e86ac353d98b9d71c6d574de41 \
  --out "$TITANIC_EXPERIMENT_ROOT/finalization"

node "$TITANIC_EXPERIMENT_ROOT/with-runtime.mjs" node "$TITANIC_EXPERIMENT_ROOT/snapshot.mjs" \
  --admission "$TITANIC_EXPERIMENT_ROOT/admission.json" --details \
  --finalization "$TITANIC_EXPERIMENT_ROOT/finalization"
```

实验目录包含本地状态与完整证据，不是源码发布包的一部分；不要将 operator 报告或 holdout 分数反馈为 Meta 的 seed 诊断输入。
