// 検出せずにマーカーを追う（src/aruco/markerTrack.ts）: 前のフレームで読めたマーカーを、少し動いた次のフレームで同じ位置に見つける。
// 回している層のマーカーのように形が変わったものは外れる
import { beforeAll, describe, expect, it } from "vitest";
import { designOf } from "../src/aruco/design";
import { ArucoBench, DEFAULT_CONFIGS } from "../src/aruco/detect";
import { trackMarkers } from "../src/aruco/markerTrack";
import { parseMoves } from "../src/cube/model";
import type { CV } from "../src/vision/image";
import { renderArucoCube, solvedStickers } from "./arucoCube";
import { loadTestOpenCv } from "./cv";

let cv: CV;
beforeAll(async () => {
  cv = await loadTestOpenCv();
}, 120000);

describe("マーカーを追う", () => {
  const design = designOf("quad-half");
  const frame = (dx: number, turn?: number) =>
    renderArucoCube(cv, { width: 1280, height: 720, stickers: solvedStickers(), orient: 0, eye: [2.4 + dx, 2.4, 5.5], noise: 2, seed: 1, scheme: "unique54", design, turn: turn ? { move: parseMoves("U")[0], fraction: turn } : undefined });

  it("少し動いたキューブのマーカーを、検出したのとほぼ同じ角で追う", () => {
    const b = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "unique54", design);
    const prev = b.detect(frame(0))[0].markers;
    const nextImg = frame(0.03);
    const truth = b.detect(nextImg)[0].markers;
    const got = trackMarkers(nextImg, prev, (id) => b.bitsOf(id), b.cellCount);
    expect(got.length).toBeGreaterThan(prev.length * 0.9);
    // 4 個の配置は同じ ID が 4 つあるので、近く（10 画素以内）にある同じ ID の検出と比べる（検出で読めなかったものは比べない）。
    // 追ったマーカーの 9 割以上は、その位置で符号どおりに読める（本体は 0.85 未満を捨てる: src/vision/arucoFrame.ts）
    const center = (c: number[]) => [(c[0] + c[2] + c[4] + c[6]) / 4, (c[1] + c[3] + c[5] + c[7]) / 4];
    const ds: number[] = [];
    for (const g of got) {
      const [x, y] = center(g.corners);
      const near = truth.filter((m) => m.id === g.id).map((m) => Math.hypot(center(m.corners)[0] - x, center(m.corners)[1] - y));
      const d = Math.min(Infinity, ...near);
      if (d < 10) ds.push(d);
    }
    expect(ds.length).toBeGreaterThan(got.length * 0.8);
    expect(got.filter((g) => b.describeMarker(nextImg, g.id, g.corners).fit >= 0.85).length).toBeGreaterThan(got.length * 0.9);
    // 検出の角も 1 画素ほどの粗さがある（角を合わせ直していない）
    ds.sort((a, c) => a - c);
    expect(ds[ds.length >> 1]).toBeLessThanOrEqual(1.5);
    expect(ds[Math.floor(ds.length * 0.9)]).toBeLessThan(3);
    b.delete();
  });

  it("層を回し始めると、その層のマーカーは外れる（追えたことにしない）", () => {
    const b = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "unique54", design);
    const prev = b.detect(frame(0))[0].markers;
    const got = trackMarkers(frame(0, 0.2), prev, (id) => b.bitsOf(id), b.cellCount);
    // U 層（上の面と、横の面の上の列）のマーカーは 18° 回って形が変わる
    expect(got.length).toBeLessThan(prev.length * 0.8);
    b.delete();
  });
});
