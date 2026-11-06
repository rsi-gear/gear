# 取消恢复验证

取消分为持久请求、确认停止两个步骤。`ProjectApplication.cancel` 只写请求，`completeCancellation` 在运行锁内逐一停止未完成的已提交操作。CLI/Skill/SDK 的 `run.cancel` 会调用这两个步骤；后台控制器先返回 `requested`。`resume` 看到取消请求后进入同一停止路径，不准备新的执行环境。

准入保存 `.gear/runs/RUN_ID/cancellation.json`，权限为 `0600`，摘要进入 `RunSpec.cancellationIdentity`。该快照只用于停止工作，不参与算法决策或结果比较，不进入报告、Meta 上下文和导出。快照损坏、adapter 无法访问或者停止确认失败，状态保持 `needs_recovery` / `cancellation-unconfirmed`。原始 operation 请求、预留、计量和研究事实保持不变。没有已提交操作时不需要任何外部连接即可确认取消。

## Adapter 合同

- `OperationProvider.cancellation` 提供私有 JSON 连接数据；`ProjectBindings.cancellation(snapshot)` 重建只有 `cancel` 方法的连接。直接注入自定义 TypeScript bindings 的开发者需要同时提供它们，才能在重启后独立取消；缺少此恢复端口不能报告已停止。
- Hitch 保存已解析的可执行文件路径、状态 root、操作目录与原 provider identity。停止时重建原 subject 的 sequence 1 pause，仍检查停止或持久 fence；不调用 resolve、worker observation 或 artifact preparation。
- Process 保存原 command、工作目录、configuration、context、实现 identity 和 `passEnv` 名称，不读取其值。恢复只发送原输入的 `cancel`，不再次 `describe`。配置仍是私有数据，不应作为可共享文件。
- Codex 在新运行准入时初始化独立作业登记表；恢复不重建缺失表。原作业取消需要执行锁释放与持久结果；模型可执行文件丢失不阻止此路径。丢失 `job.json`、作业目录、整个 namespace 或登记表时，不会据此报告从未提交或取消成功；丢失启动标记也不能重启已开始的模型。只有登记表证明尚未提交的持久 fence 可以立即确认。
- 正在运行的 controller 会在持久化请求后中断本地恢复连接，并另行执行停止确认；停止确认不依赖该恢复连接完成。

## 检查命令

```sh
npm run build
GEAR_PYTHON=/absolute/path/to/python node scripts/check-cancellation.mjs
GEAR_TEST_HITCH=/absolute/path/to/hitch node scripts/check-hitch-control.mjs
```

第一个脚本使用生产配置与 CLI、受控 process adapter，制造提交回包丢失，随后移除 profile、冻结项目/benchmark、Target 与 research 文件，并令算法 Python 不可用、禁止所有 describe/submit。新的 CLI 进程仍应通过原始取消连接确认停止，保留计量事实。此脚本没有模型调用。

第二个脚本在不含模型凭据的子进程内管理自己的 Hitch 前台 daemon，通过生产取消连接发送 pause，验证重复取消、稳定的未提交 ID 与延迟 start 被拒绝。没有 eval 作业或模型请求；退出时清理自有 daemon。它验证实际控制协议，不代表完整真实 Target 的资源清理验收。

独立 npm/wheel 安装旅程默认执行第一个脚本；设置 `GEAR_TEST_HITCH_CONTROL=1` 和 `GEAR_TEST_HITCH` 后，还会从安装后的模块执行第二个脚本。单元和集成测试另外覆盖快照损坏/还原、部分停止失败、后台控制器、重连中断、Hitch 环境漂移和实际 OS sandbox 中 Codex 子进程退出。

Codex 状态丢失与实际进程故障可用以下专项测试复核（需要当前平台的 OS sandbox）：

```sh
GEAR_PYTHON=/absolute/path/to/python \
GEAR_TRAINING_TEST_PYTHON=/absolute/path/to/python \
npx vitest run tests/integration/codex-operation.spec.ts --maxWorkers=1
npm run test:api:package
```

集成测试暂停自有 worker 后移走状态，确认不能提前停止确认或重发；还原记录后再恢复 worker 并验证模型子进程退出。另有 worker 强杀与启动标记丢失后重复派生的测试，验证模型调用只发生一次。安装包检查覆盖只读 describe、新运行准入、整个控制目录缺失的拒绝和 pre-start fence；该安装检查不启动模型。
