# Guide authoring

Edit the English and Simplified Chinese source together. `manifest.json` defines navigation, titles, languages and a closed list of public assets. Keep historical evidence and reproduction examples distinct.

Regenerate figures with `MPLCONFIGDIR=/tmp/gear-docs-mpl python scripts/render-guide-charts.py` using matplotlib 3.7+. The chart input records exact scope, provenance and known missing/global points. Do not interpolate an unevaluated candidate or compare the public research set directly to the private leaderboard.

From gear-pages:

```bash
npm run docs:sync -- --product gear --source ../gear
npm run docs:check -- --product gear --source ../gear
npm test
```

Use `--ref FULL_COMMIT_SHA` with committed source for publication. Local working-tree imports are only for preview and record that status. Builds validate a checked-in snapshot offline; they never fetch moving branches. Assets and Markdown are covered by the source lock. The two language trees must expose identical page slugs.

Example bundles contain reviewed source and summaries only. Regenerate them with `python scripts/package-guide-examples.py` when their source changes; preserve the historical Harness bytes and provenance or create a separately labeled variant.

`manifest.sourceAssets` maps repository paths to explicitly listed text/JSON attachments. `scripts/package-guide-examples.py` refreshes them from source; guide links resolve to these checksummed local copies so the documentation stays readable independently of GitHub availability. Code and Markdown are served as inert text. Add newly referenced files to this map and regenerate attachments before syncing.
