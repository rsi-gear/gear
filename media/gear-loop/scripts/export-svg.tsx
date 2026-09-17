import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GearScene } from "../src/GearScene";
import { GearArchitectureScene } from "../src/GearArchitecture";

const assets = resolve("../../docs/guide/assets");
mkdirSync(assets, { recursive: true });
mkdirSync("public", { recursive: true });
const svg = `<?xml version="1.0" encoding="UTF-8"?>\n${renderToStaticMarkup(<GearScene />)}\n`.replace(/[\t ]+$/gm, "");
for (const destination of [
  resolve(assets, "gear-loop-light.svg"),
  resolve("public/gear-loop-light.svg"),
]) {
  writeFileSync(destination, svg);
  console.log(destination);
}
writeFileSync(
  resolve(assets, "gear-loop-poster.svg"),
  renderToStaticMarkup(<GearScene frame={325} />),
);
writeFileSync(
  resolve("public/gear-loop-poster.svg"),
  renderToStaticMarkup(<GearScene frame={325} />),
);

const architecture = `<?xml version="1.0" encoding="UTF-8"?>\n${renderToStaticMarkup(<GearArchitectureScene />)}\n`.replace(/[\t ]+$/gm, "");
for (const destination of [
  resolve(assets, "gear-architecture-light.svg"),
  resolve("public/gear-architecture-light.svg"),
]) {
  writeFileSync(destination, architecture);
  console.log(destination);
}
