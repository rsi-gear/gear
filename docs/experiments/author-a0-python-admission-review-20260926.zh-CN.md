# A0 Python author async admission 性能切片独立只读审查

结论：**没有发现阻塞性功能问题；可提交此独立切片。** 它只把首次准入与首次 replay 共用一个已导入作者模块的 worker；首次使用后立即关闭，后续每轮仍新建 worker，不缓存业务状态或改变 v1 wire。它不是正式性能 benchmark 通过结论，也不是 v2 author host 已接通结论。

核对证据：

- `src/algorithm/author/python-port.ts:46–100` 在 admission 启动 worker、读取实际 `environment.describe`，冻结项目/SDK/主机源码、解释器、包版本、已加载文件与模块摘要；首次 replay 前再次检查源闭包、worker 报告和主机身份。`137–166` 只消费一次 `reserved`，`finally` 关闭该 worker；第二次及以后每次 `PythonWorker.start`，仍按同一冻结环境校验。请求明确只接受 `AUTHOR_WIRE_VERSION`（v1），拒绝 v2。
- `python-port.ts:110–136` 对未用 warm worker 设 1–60 秒有界 idle timer，显式 `close()` 幂等并等待 reserved/active/starting 释放；并发 replay 在首次 await 前被 `busy` 阻止。源码漂移先丢弃 warm worker，恢复原字节后可用新 worker 继续；异常 replay 在 `finally` 关闭 active worker。`src/algorithm/hosts/python.ts:62–89,269–288` 的 startup 超时/取消闭合 listener、child 与 socket，close 共享同一 promise。
- `packages/python-sdk/src/gear_algorithm/worker.py:101–132` 将 `fcntl` 探针置于 loaded-module 快照之前，避免同一空闲 worker 两次 `environment.describe` 产生不同身份。benchmark 脚本与 SIGKILL controller caller 已 await 工厂并在 finally 关闭端口。

独立验证：在主工作树直接跑 Python A0 + SIGKILL 两文件时先出现 **13/14**，失败为恢复阶段 `hostSource` closure drift；随后单跑 Python A0 为 **13/13**。主任务确认当时另有 agent 正在 `src/algorithm` 增加文件，而 host identity 覆盖整个目录。为排除并行写入，我在 `/private/tmp/gear-py-admission-review.OJFgYY` 用提交 `15d59e6` 加这六个冻结文件创建隔离副本，`tsc -p tsconfig.build.json` 通过；在该静止副本用 Python 3.11 与 localhost 回环独立运行 Python A0 + 真实 controller SIGKILL 两文件 **14/14 通过**。这证明首次 13/14 不宜归咎于缓存改动，也不能靠放宽身份检查消除。

环境记录：隔离副本完整 `npm run build` 在既有 `build-private-tool-fs.mjs` 的 pinned npm 包获取处遇到 `registry.npmjs.org ENOTFOUND`；拷贝主工作树已生成的 `assets/gear-tool-fs.js/.LICENSE` 后直接 `tsc -p tsconfig.build.json` 编译成功。实施者在主工作树另报告完整 build/typecheck 与相关 38 测试通过。隔离复测没有正式 benchmark、外部付费调用或 repo 修改。
