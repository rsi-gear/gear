import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const files = new Map([
  ["/", ["preview.html", "text/html; charset=utf-8"]],
  ["/preview.html", ["preview.html", "text/html; charset=utf-8"]],
  ["/gear-loop-light.svg", ["gear-loop-light.svg", "image/svg+xml"]],
  ["/gear-loop-poster.svg", ["gear-loop-poster.svg", "image/svg+xml"]],
  [
    "/gear-architecture-light.svg",
    ["gear-architecture-light.svg", "image/svg+xml"],
  ],
]);
const port = Number(process.env.GEAR_PREVIEW_PORT || 4175);
createServer(async (req, res) => {
  const entry = files.get(new URL(req.url, "http://localhost").pathname);
  if (!entry) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  try {
    const body = await readFile(resolve("public", entry[0]));
    res.writeHead(200, {
      "Content-Type": entry[1],
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Run npm run export:svg first.");
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`SVG preview: http://127.0.0.1:${port}`),
);
