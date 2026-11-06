# npm 依赖安全评估

核查日期：2026-10-11。评估范围为当前 Gear 源码和 `package-lock.json`，
不代表宿主应用、其他版本或其他依赖调用方式均不受影响。

## 已更新的依赖

| 依赖 | 锁定版本变更 | 公告 |
| --- | --- | --- |
| `shell-quote`（经 `@anthropic-ai/sandbox-runtime` 引入） | `1.10.0` → `1.12.0` | [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)，命令注入，修复版本 `>=1.11.0` |
| `source-map-js`（经 Vitest / Vite / PostCSS 引入的开发依赖） | `1.2.1` → `1.2.2` | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)，拒绝服务，修复版本 `1.2.2` |

这两项更新均满足现有父依赖的版本范围。锁文件保障本仓库 `npm ci` 的解析结果；
通过 npm 安装 Gear 的宿主项目使用自己的锁文件，也应更新并审计其依赖树。

## 尚无正式修复版本的 node-forge

[Dependabot 告警 #3](https://github.com/rsi-gear/gear/security/dependabot/3)
对应 [GHSA-86w9-cpqp-85rv / CVE-2026-85393](https://github.com/advisories/GHSA-86w9-cpqp-85rv)。
依赖链为 `rsi-gear → @anthropic-ai/sandbox-runtime@0.0.55 → node-forge@1.4.0`。
漏洞位于 RSA PKCS#1 v1.5 签名验证逻辑，受影响版本为 `<=1.4.0`。

核查时，npm 最新 `node-forge` 仍为 `1.4.0`，公告没有列出修复版本，
[上游修复 PR #1152](https://github.com/digitalbazaar/forge/pull/1152) 尚未合并。
最新 `sandbox-runtime@0.0.79` 仍依赖 `node-forge ^1.4.0`，单独升级它不能解决此告警。
`npm audit fix --force` 提议退回 `sandbox-runtime@0.0.50`；这会改变沙箱依赖契约，
不能作为经过验证的安全修复。

对当前代码和固定依赖的检查没有发现可达的漏洞利用路径：

- [`createAirGappedSandboxConfig`](../src/sandbox.ts) 禁止全部网络域名，未启用
  `tlsTerminate` 或 `mitmProxy`。全局策略比较包含这两个字段，Notebook、candidate shell
  和 compiler 执行前会拒绝不匹配的配置。
- `sandbox-runtime@0.0.55` 只有显式启用 `tlsTerminate` 才会创建 MITM CA。
  其发布包内仅 `mitm-ca.js` 和 `mitm-leaf.js` 导入 forge，用于证书解析、生成和签名，
  未发现 forge RSA 验签或证书链验证调用。
- 即使在上游的 TLS termination 模式下，上游 HTTPS 证书验证也通过 Node.js
  的 HTTPS/TLS 实现完成。固定版本源码可查阅
  [CA 实现](https://github.com/anthropics/sandbox-runtime/blob/b85464e9cc99f11963621ab4b9b79af7721f98c2/src/sandbox/mitm-ca.ts)、
  [叶证书实现](https://github.com/anthropics/sandbox-runtime/blob/b85464e9cc99f11963621ab4b9b79af7721f98c2/src/sandbox/mitm-leaf.ts) 和
  [TLS 代理](https://github.com/anthropics/sandbox-runtime/blob/b85464e9cc99f11963621ab4b9b79af7721f98c2/src/sandbox/tls-terminate-proxy.ts)。

上述判断是当前调用路径的可达性评估，**不是 node-forge 已修复的声明**。
保留告警；不通过忽略审计、伪造版本号或依赖降级消除提示。
修改沙箱网络配置、升级 sandbox-runtime 或引入新的 forge 调用时，需重新评估。

## 复核与解除条件

```sh
npm ci
npm ls node-forge shell-quote source-map-js --all
npm audit
npm run typecheck
npm run build
npm run test:sandbox:platform
npm pack --dry-run --ignore-scripts
```

当前 `npm audit` 仍会因 node-forge 及其父依赖返回非零退出码；这是同一条未修复公告
影响两个依赖条目，并不表示审计已通过。沙箱测试覆盖默认不启用 TLS termination / MITM，
以及全局策略被改为启用这些功能时拒绝执行的边界；这些测试不替代 forge 自身的漏洞修复。

正式修复版发布后，更新依赖树并运行上述检查，确认公告对应条目从审计中消失。
提交锁文件进入默认分支、GitHub 完成依赖扫描后，再核实 Dependabot 状态。
