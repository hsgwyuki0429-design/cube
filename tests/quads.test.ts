// 四角形の候補（src/vision/quads.ts）の速い処理が、OpenCV の素直な処理と画素単位で同じ結果になること
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMoves, parseMoves, solvedState } from "../src/cube/model";
import { type CV, DEFAULT_QUADS, QuadFinder, findQuads, initOpenCv, maxRgb, median5Binary, morphEllipse } from "../src/vision/quads";
import { renderCube } from "./render";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

// ステッカーレスのキューブ（溝の候補を使う場面）
const image = (seed: number) => renderCube({ width: 640, height: 480, state: applyMoves(solvedState(), parseMoves("R U F' L2")), orient: 0, eye: [0.8, 4.5, 9], seed, gap: 0 });
const same = (a: CV, b: CV) => Buffer.from(a.data).equals(Buffer.from(b.data));

describe("速い処理が同じ結果になる", () => {
  it("max(R, G, B) は HSV の V と同じ", () => {
    const rgba = cv.matFromImageData(image(1));
    const rgb = new cv.Mat();
    const hsv = new cv.Mat();
    const ch = new cv.MatVector();
    const v = new cv.Mat(rgba.rows, rgba.cols, cv.CV_8UC1);
    try {
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      cv.split(hsv, ch);
      maxRgb(rgba.data, v.data);
      const ref = ch.get(2);
      expect(same(v, ref)).toBe(true);
      ref.delete();
    } finally {
      for (const m of [rgba, rgb, hsv, ch, v]) m.delete();
    }
  });

  it("楕円での膨張・収縮（長方形の組み合わせ）は cv.dilate / cv.erode と同じ（端も、同じ画像への書き込みも）", () => {
    const rgba = cv.matFromImageData(image(2));
    const v = new cv.Mat(rgba.rows, rgba.cols, cv.CV_8UC1);
    maxRgb(rgba.data, v.data);
    try {
      for (const k of [5, 7, 13, 21]) {
        const ell = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
        for (const op of ["dilate", "erode"] as const) {
          const ref = new cv.Mat();
          const out = new cv.Mat();
          const inPlace = new cv.Mat();
          v.copyTo(inPlace);
          cv[op](v, ref, ell);
          morphEllipse(cv, v, out, op, k);
          morphEllipse(cv, inPlace, inPlace, op, k);
          expect(same(out, ref)).toBe(true);
          expect(same(inPlace, ref)).toBe(true);
          for (const m of [ref, out, inPlace]) m.delete();
        }
        ell.delete();
      }
    } finally {
      rgba.delete();
      v.delete();
    }
  });

  it("2 値の画像の 5×5 のメディアン（数えて決める）は cv.medianBlur と同じ", () => {
    const rgba = cv.matFromImageData(image(3));
    const v = new cv.Mat(rgba.rows, rgba.cols, cv.CV_8UC1);
    maxRgb(rgba.data, v.data);
    const mask = new cv.Mat();
    const ref = new cv.Mat();
    const tmp = new cv.Mat();
    try {
      for (const th of [60, 120, 180]) {
        cv.threshold(v, mask, th, 255, cv.THRESH_BINARY);
        cv.medianBlur(mask, ref, 5);
        median5Binary(cv, mask, tmp);
        expect(same(mask, ref)).toBe(true);
      }
    } finally {
      for (const m of [rgba, v, mask, ref, tmp]) m.delete();
    }
  });

  it("溝の候補を何度作っても、そのたびに作り直したのと同じ", () => {
    const rgba = cv.matFromImageData(image(4));
    const f = new QuadFinder(cv, rgba, DEFAULT_QUADS);
    try {
      expect(f.quads()).toEqual(findQuads(cv, rgba, DEFAULT_QUADS));
      for (const th of [10, 6, 10]) expect(f.withGrooves(th)).toEqual(findQuads(cv, rgba, { ...DEFAULT_QUADS, grooves: true, grooveThreshold: th }));
      // 溝で区切ったセルが加わる
      expect(f.withGrooves(10).length).toBeGreaterThan(f.quads().length);
    } finally {
      f.delete();
      rgba.delete();
    }
  });
});
