# 共享 task 镜像准备（显式启用）

此工具把 native Harbor 数据集中声明的公共构建前缀准备成 OCI 镜像。
新 task 目录保留每题差异、指令和验证入口，公共源码与依赖由镜像层承载。
它不把 Harbor 放入容器，也不改变候选、服务或验证器的容器数量。
每个容器仍有独立可写层；任务修改文件时由 Docker 执行 copy-on-write。

入口随 Gear Python 包发布：`python -m gear.benchmark.shared_runtime`。
这是导入之前的可选生产工具，不自动修改已冻结的 benchmark 或历史实验。
不适用的任务继续使用原数据集；显式请求转换但不满足条件时报告错误，
不会生成一个看似成功、实际缺少输入的数据集。

## 声明

输入必须是有 `benchmark.adapter.json` 的 native v1 数据集。每个任务的所有
Dockerfile 都要声明其实际构建上下文。以这份 Dockerfile 为例：

工具遵循 Gear native 冻结合同：普通文件归一化为 `0644`，可执行文件为
`0755`，与 `compile_harbor` 相同。它不承诺保留未经 Gear 导入的作者目录中
额外的组写入权限、所有者或 ACL；需要这些元数据的任务应保留原路径。

```dockerfile
FROM registry/python@sha256:REPLACE_WITH_REAL_DIGEST
COPY runtime /runtime
WORKDIR /runtime
CMD ["python", "worker.py"]
```

假设只有 `runtime/task.json` 因题目而异，其他文件只供镜像构建使用：

```json
{
  "schema_version": "1",
  "platform": "linux/amd64",
  "tasks": ["task-a", "task-b"],
  "image_only": ["environment/runtime", "tests/runtime"],
  "builds": [
    {"context": "environment", "dockerfile": "Dockerfile", "prefix_lines": 2,
     "varying": ["runtime/task.json"]},
    {"context": "tests", "dockerfile": "Dockerfile", "prefix_lines": 2,
     "varying": ["runtime/task.json"]}
  ]
}
```

- `prefix_lines` 是包含注释、空行的原始行数。该前缀包含 FROM 和公共构建步骤。
- `varying` 相对于构建上下文。文件只能在前缀最后一条目录 COPY 中首次出现；
  工具将其排除出公共镜像，再在每题 Dockerfile 的 FROM 后，对保留的精简目录
  重做原目录 COPY，保留目标符号链接的覆盖语义。
  任何公共 RUN 均不能观察到被移走的题目文件。
- `image_only` 相对于 task 根目录，是作者对宿主用途的显式承诺：这些输入不供
  solution、宿主验证脚本或其他非构建消费者读取。工具仅删除其中已被公共前缀
  消费、且不再被任何剩余 COPY 使用的文件；后续使用的空目录也保留。
- 内容、文件可执行位、空目录、构建前缀或平台不同会产生不同配方。候选与私有
  验证器只在完整输入相同时共享镜像，不会把验证器源码加入候选镜像。

## 准备、构建、绑定

```sh
python -m gear.benchmark.shared_runtime prepare \
  --source /data/native-v1 --input plan.json --out /data/prepared-new
```

`prepared.json` 给出配方摘要；`contexts/<摘要>/` 是可审查的独立构建上下文。
该步骤只写公共上下文和精简模板，不构建或发布镜像。使用自己控制的 registry
逐个构建、推送，再将每个配方摘要映射到对应的不可变镜像引用：

```sh
docker build --provenance=false --platform linux/amd64 \
  -t REGISTRY/runtime:RECIPE /data/prepared-new/contexts/RECIPE
docker push REGISTRY/runtime:RECIPE
docker image inspect REGISTRY/runtime:RECIPE
```

```json
{
  "sha256:RECIPE_DIGEST": "REGISTRY/runtime@sha256:MANIFEST_DIGEST"
}
```

```sh
python -m gear.benchmark.shared_runtime bind \
  --source /data/prepared-new --input images.json --out /data/native-shared-new
```

绑定核对准备目录摘要、本地镜像的 RepoDigest、平台、配方标签，并拒绝 ONBUILD
和隐式 VOLUME。镜像需已在本机可检查；在其他机器上先 pull 对应摘要。
配方标签用于发现误用镜像，不能证明不受信任的构建者诚实地执行了配方。
构建者和镜像发布过程仍属于可信边界；依赖应使用锁文件。

输出重新计算 task/dataset 摘要，保留评分定义、原始来源元数据，并在每题中
记录镜像绑定。将新数据集按普通 Harbor 数据集导入 Gear；不要替换正在运行的
实验所引用的数据集。公共上下文可以留作重建证据，不进入每题冻结载荷。

## 支持范围与成本

目前支持 Linux amd64/arm64、固定摘要单阶段 FROM、字面量 COPY、普通
RUN/ENV/WORKDIR/USER/CMD/ENTRYPOINT 前缀。未覆盖的 Dockerfile 语法、
ignore 文件、构建参数/target、跨阶段输入、外部挂载和前缀之后的 ENTRYPOINT
保留原构建方式，不尝试猜测其语义。所有活跃消费者必须使用声明的 context。

首次准备需要读取原数据集、写一份公共上下文并构建/保存镜像。后续每批 task
不再物化公共源码，容器共享镜像下层。任务输出、日志、临时文件、实际修改的
文件和 Docker 元数据仍会写盘，不能据此声称整个执行阶段零写盘。

真实 Docker 回归使用一个通用双任务 fixture，检查文件内容、权限、空目录、
镜像配置及并行容器内修改的隔离，不调用模型：

```sh
GEAR_SHARED_RUNTIME_DOCKER_TEST=1 \
GEAR_SHARED_RUNTIME_TEST_REGISTRY=127.0.0.1:5000 \
GEAR_SHARED_RUNTIME_TEST_IMAGE='python@sha256:REAL_DIGEST' \
PYTHONPATH=python python -m unittest discover \
  -s python/tests -p test_shared_runtime_docker.py -v
```

测试 registry 由调用者提供；测试只推送随机命名的测试仓库，结束时删除本机
测试 tag。registry 中的测试内容由其所有者按保留策略回收。
