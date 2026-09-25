# A2b 历史任务经验导入审计

结论：这个狭义任务导入切片可以提交；尚未完成真实历史成功样本与 Hitch 轨迹导入验收。

新增 inspectHistoricalSeedTaskSource 和 importHistoricalSeedTaskView。宿主先保存明确历史来源的 pin，再重验 registry/spec/round、编译 seed 数据集、用途授权与源摘要；验证后复用现有 HistoricalSeedExperienceSource → sealExperienceView → prepareTaskViewFromExperience → TaskViewAuthority.seal。仅接受 train/development 任务，保留 seed 的 seenInTraining=true；不能将旧分数转为新 measurement，也不能把曾参与搜索的任务升级为 clean final-test。缺 registry/spec 的失败 round 仍只能作为报告查看。

源和目标 CAS 的真实路径必须分离，包含 workspace 外的绝对数据集路径。主审补充发现 FileArtifactStore 允许既有 objects 链接，单验 CAS 根无法阻止写回历史源；入口已增加对象目录 lstat/realpath 检查与对应拒绝测试。调用方创建 CAS 本身可能写目标目录，本 API 只承诺在完成身份/授权/路径验证前不新增输出对象。

EvolutionRegistryStore.readEntry 现在直接读取并验证已有 registry；不再经 list/initialize 刷新 experiments.tsv。list 的现有行为保持。测试确认源目录字节与 sentinel 索引不变，缺 registry 不会创建目录；覆盖缺记录、数据集漂移、伪造 pin、任务越权/重复、用途越权、另一 CAS authority、源目标重叠及对象目录链接。

实施者在独立副本 /private/tmp/gear-a2b-freeze.KpQIzS 直接 tsc 构建、全仓类型检查及五文件 43 项通过。npm run build 的前置私有 tool-fs 打包无法访问 registry，不能记为该命令通过。主审独立运行三文件 20 项（新导入、历史经验及旧报告），全部通过，三个切片文件与冻结副本逐字节一致。

限制：此 API 不导入 Hitch 轨迹、旧预算/作业或训练模型；完整 RunSpec 历史输入接线另实现。复用的 legacy JSON reader 仍存在未统一的读取上界，不宣称全路径有界。已有真实失败样本缺 registry/spec/编译任务集，只能验证 record-only，不能替代真实成功导入门。
