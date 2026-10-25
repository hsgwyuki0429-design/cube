// 1 フレームの処理時間の内訳（実際の動画のフレームで）。PERF_DIR=frames（meta.json と .rgba）
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "vitest";
import { DEFAULT_PIPELINE, type PipelineMemory, processFrame } from "../../src/vision/pipeline";
import { DEFAULT_QUADS, findQuads, initOpenCv } from "../../src/vision/quads";

it("perf", async () => {
  const DIR = process.env.PERF_DIR ?? "";
  if (!existsSync(`${DIR}/meta.json`)) return;
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const meta = JSON.parse(readFileSync(`${DIR}/meta.json`, "utf8")) as Record<string, [number, number]>;
  const imgs = Object.entries(meta).slice(0, 30).map(([n, [w, h]]) => ({ data: new Uint8ClampedArray(readFileSync(`${DIR}/${n}.rgba`)), width: w, height: h }));
  const time = (f: () => void) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  for (const img of imgs.slice(0, 3)) processFrame(cv, img, 0, DEFAULT_PIPELINE, { last: null }, null, []);
  const mem: { last: PipelineMemory | null } = { last: null };
  let full = 0, base = 0, groove = 0;
  imgs.forEach((img, i) => {
    full += time(() => processFrame(cv, img, i * 33, DEFAULT_PIPELINE, mem, null, []));
    const m = cv.matFromImageData(img);
    base += time(() => findQuads(cv, m, DEFAULT_QUADS));
    groove += time(() => findQuads(cv, m, { ...DEFAULT_QUADS, grooves: true }));
    m.delete();
  });
  const n = imgs.length;
  process.stdout.write(`${imgs[0].width}x${imgs[0].height}: processFrame ${(full / n).toFixed(1)}ms  findQuads ${(base / n).toFixed(1)}ms  findQuads+grooves ${(groove / n).toFixed(1)}ms\n`);
});
