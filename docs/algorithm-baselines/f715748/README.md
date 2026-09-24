# Search runtime baseline at `f715748`

This baseline records the exact tracked Git revision `f715748dad576d3055e4a9eaab21b36015348aee`. [manifest.json](manifest.json) contains the source and built search identity closures, every closure file's SHA-256 and size, the default parent policy identity, `package.json`/lock hashes, build tool versions, and the locally packed release archive hash. It contains no generated `lib`, dependencies, credentials, or runtime state.

The capture script does not use the current worktree as source. It extracts `git archive` for the requested commit into a new directory, copies that snapshot for the build, links an existing dependency tree, runs the old pinned private ToolFs builder with its exact input tarball, compiles with the old build tsconfig, compares calculated identities with the executable built modules, and packs the old package with scripts disabled. The ToolFs input is checked against the SHA-512 pin in that commit's builder. The script never installs packages, calls a registry, resets the repository, or replaces an existing output directory.

Required local inputs for this capture were Node `v26.5.1`, npm `11.17.0`, TypeScript `6.0.3`, esbuild `0.27.4`, and an existing `node_modules` compatible with [package-lock.json](../../../package-lock.json). The private ToolFs source tarball is `@deepseek-ai/dsh-tool-fs@0.1.1-rc.2`, SHA-512 `llX8AWbaI3CGme/a2eeTSfy5atk8u3iJeOFzmZV/KZ0v0hMhKZIK1xQInWwC9OmSDJ/StStJe0hDPVLWbB7hVg==`. This run obtained those exact tarball bytes from the local npm cache; the cache is not part of this baseline. Preserve that input and the generated package archive in a durable artifact store before relying on them to resume historical work. Their checked digests are in the manifest.

Run the capture and verify it against this manifest with a **new** output directory:

```sh
node scripts/capture-algorithm-baseline.mjs \
  --revision f715748dad576d3055e4a9eaab21b36015348aee \
  --output /private/tmp/gear-algorithm-baseline-f715748-new \
  --node-modules /path/to/existing/node_modules \
  --tool-fs-archive /path/to/dsh-tool-fs-0.1.1-rc.2.tgz \
  --expected docs/algorithm-baselines/f715748/manifest.json
```

The verified run produced these identities:

| Identity | SHA-256 |
| --- | --- |
| Search source | `3f7c2be47dc1083d409b67b733a2d61da9837b5d21115b55d6ba5ed0f5c4795a` |
| Search built JS | `59106d8db24cb2262c56bcfe2e3db3d2318e20340f3147601a4ce9433cb55d6f` |
| Default parent policy source | `546e28a482f7174889926766ab67e9bf6c367f379b1af795d5c3bdf39fb155f9` |
| Default parent policy built JS | `a06adaca929b9a0387df3a373f86851f40d3e78db2f971ccd61b1c2e41366e92` |
| `package.json` | `c6031c3acd4d66f5d7f259c77bc14785bcc148de9da326fb67380a3027890f8b` |
| `package-lock.json` | `e1bae19d37163501f897509468fabed60cd7bb90151ba738d8e4e810941e6a1f` |
| Packed `rsi-gear-0.1.0.tgz` | `287915fa34c5cae430b51898f3e6a651e13f50665028bd791319aea570a36656` |

Targeted baseline tests ran inside the extracted old build with:

```sh
node node_modules/vitest/vitest.mjs run \
  tests/unit/search-freeze-recovery.spec.ts tests/unit/search-recovery.spec.ts \
  tests/unit/search-policies.spec.ts tests/unit/search-acceptance.spec.ts \
  tests/unit/component-identity.spec.ts tests/unit/component-identity-build.spec.ts \
  --maxWorkers=2
```

Result: **6 files, 95 tests passed**. A second independent capture with `--expected` matched the manifest, including the packed archive hash. An altered expected built search digest was rejected with `baseline differs from expected manifest: builtSearch` (exit 1).

The ordinary `npm run build` initially failed because its pinned ToolFs `npm pack --prefer-offline` attempted to reach the registry, and `npm_config_offline=true` alone then failed because npm's metadata cache was incomplete. The capture script supplies the already cached, SHA-512 verified source tarball to the unchanged old builder through a narrow local `npm pack` shim. TypeScript compilation and local package packing then completed without network access. The old package archive includes `lib/search/identity.js`, `lib/search/policies/parents.js`, `package.json`, and generated ToolFs assets.

The generated ToolFs bundle also contains esbuild source path comments. The original checkout's generated bundle had different comments because it was built with dependencies at a different path, although its ToolFs license was identical. This means a later build may preserve the search identities yet fail the exact package tarball digest on another machine. Keep the captured tarball itself for byte-exact runtime recovery; a Git commit and lockfile alone do not prove byte-identical generated assets.

The original checkout's pre-existing `lib` is **not** this Git revision's verified build: its executable search integrity reports `sha256:7d595e441c6bcab9d9c00e4ae90b73fb52cd3489dbb36c5cbaaf3d16070fa7f0`, while a fresh `f715748` build reports `sha256:59106d8d...`; multiple generated closure files differ. No historical runtime can be assumed to match this one solely because the checkout has the same HEAD. Actual running experiments need their sealed algorithm and parent policy identities compared against the exact preserved executable package and dependency environment they used.

The default parent policy includes the **full package manifest bytes** in its identity (`src/search/policies/parents.ts:8-12`); changing exports, bin, files, or scripts later changes that policy identity even if the search algorithm source closure stays unchanged. In S6, a new CLI may inspect old state read-only and dispatch a matching old runtime in a separate installation/process with its original package manifest and dependencies, while one writer owns the old state. If the matching runtime is unavailable, refuse resume and report the missing identity. Do not rewrite sealed state, substitute this baseline for a different identity, relax identity checks, or quietly import an old evolution as a new campaign. An import is a new experiment with explicit lineage.
