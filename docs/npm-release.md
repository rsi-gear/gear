# npm 自动发布

`.github/workflows/publish-npm.yml` 参考 Hitch 的 npm OIDC 发布方式。
合并到 `main` 后，等待同一次提交的 `CI` 成功，自动构建并发布 `rsi-gear`。
不需要先创建 GitHub Release，也不自动创建 tag 或提交版本号。

## 版本与触发

- 版本取自 `package.json`；`package-lock.json` 的两个版本字段必须一致。
- npm 上已有的版本直接跳过。需要发布新版本时，先运行
  `npm version patch --no-git-tag-version`（或 `minor` / `major`），将两个文件一起合并到 `main`。
- 正式版本发布到 `latest`，如 `0.2.0-rc.1` 的预发布版本发布到 `next`。
- 仅接受本仓库 `main` 的成功 push CI，PR、fork、失败和取消的 CI 不发布。
- 构建前、发布前均确认该提交仍为 `main` 最新提交，避免晚完成的旧 CI 覆盖新发布。
- 发布按顺序执行，不中断正在上传的包；失败后可以重跑发布工作流。

## 一次性配置

### 首次创建 npm 包

如果 npm 上尚无 `rsi-gear`，在 GitHub 仓库的 Actions secrets 中添加
`NPM_TOKEN`，使用具有创建/发布该包权限、允许 CI 发布的 npm granular token。
不要把 token 写入仓库。也可以先在本地登录 npm 完成首次发布，再配置下方的 OIDC。

### 后续使用 OIDC（与 Hitch 一致）

在 npm 的 `rsi-gear` 包设置中添加 GitHub Actions Trusted Publisher：

| 字段 | 值 |
| --- | --- |
| Organization or user | `rsi-gear` |
| Repository | `gear` |
| Workflow filename | `publish-npm.yml` |
| Environment name | 留空 |
| Allowed actions | 启用直接 `npm publish` |

工作流启用 `id-token: write`，使用 GitHub-hosted runner、Node 24 和 npm 11。
配置好后可删除用于首发的 `NPM_TOKEN`。包中的 `repository.url` 与 GitHub 仓库保持一致。
私有 GitHub 仓库也可使用 OIDC，但 npm 不为其生成 provenance；工作流不强制该选项。

详见 [npm trusted publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

## 发布检查

主 CI 已通过后，发布工作流重新执行 `npm ci`、typecheck、build、打包内容检查，
以及外部消费者的 search API 检查。`npm publish --ignore-scripts` 使用已验证的构建，
避免重复执行 `prepack`。注册表查询超时或非 404 错误会失败，不会被当成“版本不存在”。

本地检查（不会发布）：

```sh
node --test .github/scripts/*.test.mjs
node .github/scripts/npm-release.mjs
npm run typecheck
npm run build
npm pack --dry-run --ignore-scripts
node scripts/check-search-package.mjs
```
