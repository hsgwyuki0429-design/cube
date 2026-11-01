// 超広角など焦点距離の違うカメラで、3D の傾き（姿勢）が求まるか（src/vision/pose.ts の FocalTracker）
//   npx vitest run -c vitest.debug.config.ts tests/debug/wide.debug.test.ts
import { it } from "vitest";
import { STICKERS, designOf } from "../../src/aruco/design";
import { FocalTracker, estimatePose, rotationAngle } from "../../src/vision/pose";
import { processFrame } from "../../src/vision/pipeline";
import { renderArucoCube, solvedStickers } from "../arucoCube";
import { loadTestOpenCv } from "../cv";

it("超広角", async () => {
  const cv = await loadTestOpenCv();
  const design = designOf(STICKERS.arucoDesign);
  for (const k of [0.8, 0.55, 0.4]) {
    for (const [w, h] of [[1280, 720], [720, 1280]]) {
      const f = Math.max(w, h) * k;
      const tracker = new FocalTracker();
      const memory = {};
      let ok = 0;
      let okDef = 0;
      const n = 12;
      const angles: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = i * 0.35;
        const base: [number, number, number] = [2.4 + Math.sin(a) * 1.2, 2.2 + Math.cos(a * 0.7) * 0.8, 5.2];
        const e = base.map((v) => (v * k) / 0.8) as [number, number, number];
        const img = renderArucoCube(cv as never, { width: w, height: h, stickers: solvedStickers(), orient: 0, eye: e, focal: f, noise: 2, seed: i, scheme: "unique54", design });
        const r = processFrame(cv as never, img, i * 100, { ...STICKERS }, memory);
        const ref = estimatePose(r.faces, w, h, f);
        const p = tracker.estimate(r.faces, w, h);
        const def = estimatePose(r.faces, w, h);
        const th = Math.max(4, w / 100);
        if (p && p.err < th) ok++;
        if (def && def.err < th) okDef++;
        if (p && ref) angles.push((rotationAngle(p.R, ref.R) * 180) / Math.PI);
      }
      process.stdout.write(`k=${k} ${w}x${h}: 使える姿勢 ${ok}/${n}（決め打ち ${okDef}/${n}）・覚えた焦点距離 ${(tracker.focal / Math.max(w, h)).toFixed(2)}×長辺・正しい焦点距離との差 平均 ${(angles.reduce((s, v) => s + v, 0) / Math.max(1, angles.length)).toFixed(1)}°\n`);
    }
  }
}, 600000);
