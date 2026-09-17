import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

mkdirSync(".cache", { recursive: true });
await build({
  entryPoints: ["scripts/export-svg.tsx"],
  outfile: ".cache/export-svg.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  jsx: "automatic",
});
execFileSync(process.execPath, [".cache/export-svg.cjs"], { stdio: "inherit" });
