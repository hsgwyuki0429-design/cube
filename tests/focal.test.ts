// 焦点距離の見積もり（src/vision/pose.ts の FocalTracker）: 超広角（長辺の 0.4 倍）でも 3D の傾き（姿勢）が求まる。
// 決め打ち（0.8 倍）のままだと再投影の誤差が大きく、姿勢を捨てて 3D が真正面（1 面だけ）のままだった
import { beforeAll, describe, expect, it } from "vitest";
import { STICKERS, designOf } from "../src/aruco/design";
import type { CV } from "../src/vision/image";
import { processFrame } from "../src/vision/pipeline";
import { FocalTracker, estimatePose } from "../src/vision/pose";
import { renderArucoCube, solvedStickers } from "./arucoCube";
import { loadTestOpenCv } from "./cv";

let cv: CV;
beforeAll(async () => {
  cv = await loadTestOpenCv();
}, 120000);

describe("焦点距離の見積もり", () => {
  it("超広角でも姿勢が求まり、焦点距離を覚える", () => {
    const design = designOf(STICKERS.arucoDesign);
    const [w, h] = [1280, 720];
    const k = 0.4;
    const tracker = new FocalTracker();
    const memory = {};
    let ok = 0;
    let okDefault = 0;
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = i * 0.35;
      const eye = [2.4 + Math.sin(a) * 1.2, 2.2 + Math.cos(a * 0.7) * 0.8, 5.2].map((v) => (v * k) / 0.8) as [number, number, number];
      const img = renderArucoCube(cv, { width: w, height: h, stickers: solvedStickers(), orient: 0, eye, focal: Math.max(w, h) * k, noise: 2, seed: i, scheme: "unique54", design });
      const r = processFrame(cv, img, i * 100, { ...STICKERS }, memory);
      const th = Math.max(4, w / 100);
      if ((tracker.estimate(r.faces, w, h)?.err ?? Infinity) < th) ok++;
      if ((estimatePose(r.faces, w, h)?.err ?? Infinity) < th) okDefault++;
    }
    expect(okDefault).toBe(0);
    expect(ok).toBeGreaterThanOrEqual(n - 1);
    expect(tracker.focal / Math.max(w, h)).toBeGreaterThan(0.35);
    expect(tracker.focal / Math.max(w, h)).toBeLessThan(0.48);
  }, 120000);
});
