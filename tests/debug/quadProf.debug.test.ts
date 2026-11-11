import { spawnSync } from "node:child_process";
import { it } from "vitest";
import { QuadDetector } from "../../src/aruco/quadDetect";
import { profile, summarize } from "./prof";
it("prof", async () => {
  const file = process.env.REAL_VIDEO!;
  const W = 1280, H = 720;
  const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", process.env.AT ?? "14", "-i", file, "-vf", `scale=${W}:${H}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 26 }).stdout;
  const img = { data: new Uint8ClampedArray(raw), width: W, height: H };
  const d = new QuadDetector("unique54", JSON.parse(process.env.QOPT ?? "{}"));
  for (let i = 0; i < 20; i++) d.detect(img);
  const N = 60;
  const t0 = performance.now();
  const r = await profile(() => { for (let i = 0; i < N; i++) d.detect(img); });
  console.log(`全体 ${((performance.now() - t0) / N).toFixed(2)}ms`, JSON.stringify(d.stats));
  console.log(summarize(r.nodes, r.interval, N, 14));
  const best = (f: () => void) => { let m = Infinity; for (let k = 0; k < 8; k++) { const a = performance.now(); for (let i = 0; i < 20; i++) f(); m = Math.min(m, (performance.now() - a) / 20); } return m; };
  console.log(`最小: 全体 ${best(() => d.detect(img)).toFixed(2)}ms・切り出し ${best(() => d.detect(img, { x: 400, y: 150, w: 500, h: 500 })).toFixed(2)}ms`);
  {
    const { loadTestOpenCv } = await import("../cv");
    const { ArucoBench, DEFAULT_CONFIGS } = await import("../../src/aruco/detect");
    const { designOf, STICKERS } = await import("../../src/aruco/design");
    const cv = await loadTestOpenCv();
    const b = new ArucoBench(cv as never, [DEFAULT_CONFIGS[1]], "unique54", designOf(STICKERS.arucoDesign));
    for (let i = 0; i < 5; i++) b.detect(img);
    console.log(`OpenCV 最小: 全体 ${best(() => b.detect(img)).toFixed(2)}ms・切り出し ${best(() => b.detect(img, { x: 400, y: 150, w: 500, h: 500 })).toFixed(2)}ms・マーカー ${b.detect(img)[0].markers.length}/${b.detect(img, { x: 400, y: 150, w: 500, h: 500 })[0].markers.length}（専用 ${d.detect(img).length}/${d.detect(img, { x: 400, y: 150, w: 500, h: 500 }).length}）`);
  }
  const reg = { x: 400, y: 150, w: 500, h: 500 };
  const t1 = performance.now();
  for (let i = 0; i < N; i++) d.detect(img, reg);
  console.log(`切り出し 500×500 ${((performance.now() - t1) / N).toFixed(2)}ms`, JSON.stringify(d.stats));
}, 600000);
