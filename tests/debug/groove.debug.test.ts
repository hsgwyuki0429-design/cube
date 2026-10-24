// ステッカーレスキューブの溝（ピースの間の細い暗い線）を強調して、同じ色がつながったブロックをセルに分けられるか試す。
//   REAL_DIR=/path/to/frames REAL_OUT=/path/to/out npx vitest run -c vitest.debug.config.ts tests/debug/groove.debug.test.ts
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "vitest";
import { DEFAULT_QUADS, findQuads, initOpenCv } from "../../src/vision/quads";
import { findFaces } from "../../src/vision/lattice";
import { drawLine, writePng } from "./png";

const DIR = process.env.REAL_DIR ?? "/home/user/realdata/frames";
const OUT = process.env.REAL_OUT ?? "/tmp/real-out";
const ONLY = process.env.REAL_ONLY;
const K = Number(process.env.K ?? 9);
const T = Number(process.env.T ?? 10);

it("groove", async () => {
  if (!existsSync(`${DIR}/meta.json`)) return;
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const meta = JSON.parse(readFileSync(`${DIR}/meta.json`, "utf8")) as Record<string, [number, number]>;
  for (const [name, [w, h]] of Object.entries(meta)) {
    if (ONLY && !name.startsWith(ONLY)) continue;
    const data = new Uint8ClampedArray(readFileSync(`${DIR}/${name}.rgba`));
    const src = cv.matFromImageData({ data, width: w, height: h });
    const rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const hsv = new cv.Mat();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const ch = new cv.MatVector();
    cv.split(hsv, ch);
    const v = ch.get(2);
    const bh = new cv.Mat();
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(K, K));
    cv.morphologyEx(v, bh, cv.MORPH_BLACKHAT, k);
    const out = { data: new Uint8ClampedArray(data), width: w, height: h };
    if (process.env.MASK) {
      // findQuads と同じ手順でセルの領域を作り、連結成分ごとに色を塗る
      const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      const edges = new cv.Mat(); cv.Canny(gray, edges, 20, 60);
      const lab = new cv.Mat(); cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab); const lch = new cv.MatVector(); cv.split(lab, lch); const e = new cv.Mat();
      for (const kk of [1, 2]) { const c = lch.get(kk); cv.GaussianBlur(c, c, new cv.Size(5, 5), 0); cv.Canny(c, e, 12, 36); cv.bitwise_or(edges, e, edges); c.delete(); }
      const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)); cv.dilate(edges, edges, k3);
      const mask = new cv.Mat(); cv.threshold(bh, mask, T, 255, cv.THRESH_BINARY_INV);
      const br = new cv.Mat(); cv.threshold(v, br, 60, 255, cv.THRESH_BINARY); cv.bitwise_and(mask, br, mask);
      const ne = new cv.Mat(); cv.bitwise_not(edges, ne); cv.bitwise_and(mask, ne, mask);
      const E = Number(process.env.E ?? 7); const sh = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(E, E)); cv.erode(mask, mask, sh);
      const labels = new cv.Mat(); const n = cv.connectedComponents(mask, labels);
      for (let i = 0; i < w * h; i++) { const l = labels.data32S[i]; if (!l) { out.data[i*4]>>=2; out.data[i*4+1]>>=2; out.data[i*4+2]>>=2; continue; } out.data[i*4] = (l*97)%256; out.data[i*4+1] = (l*57)%256; out.data[i*4+2] = (l*151)%256; }
      process.stdout.write(`${name}: components=${n}\n`);
      for (const m of [gray, edges, lab, e, k3, mask, br, ne, sh, labels]) m.delete(); lch.delete();
    }
    for (let i = 0; i < w * h; i++) {
      const g = bh.data[i];
      if (g > T) {
        out.data[i * 4] = 255;
        out.data[i * 4 + 1] = 0;
        out.data[i * 4 + 2] = 0;
      }
    }
    const base = findQuads(cv, src, { ...DEFAULT_QUADS, grooves: false });
    const all = findQuads(cv, src, { ...DEFAULT_QUADS, grooveThreshold: T, grooveErode: Number(process.env.E ?? 7) });
    const qs = all.filter((q) => !base.some((b) => Math.hypot(b.center[0] - q.center[0], b.center[1] - q.center[1]) < 3));
    for (const q of base) for (let j = 0; j < 4; j++) drawLine(out, q.corners[j] as [number, number], q.corners[(j + 1) % 4] as [number, number], [255, 0, 255]);
    for (const q of qs) for (let j = 0; j < 4; j++) drawLine(out, q.corners[j] as [number, number], q.corners[(j + 1) % 4] as [number, number], [0, 255, 255]);
    const fa = findFaces(all, {});
    const fb = findFaces(base, {});
    process.stdout.write(`${name} lattice all=${fa.map((f) => f.found).join(",")} base=${fb.map((f) => f.found).join(",")}\n`);
    process.stdout.write(`${name}: base=${base.length} all=${all.length} new=${qs.length}\n`);
    writePng(`${OUT}/${name}-groove.png`, out);
    for (const m of [src, rgb, hsv, v, bh, k]) m.delete();
    ch.delete();
  }
}, 600000);
