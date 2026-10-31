// 精密解析の並列化（src/vision/detectPool.ts の ParallelFeeder）: 検出を別の Worker に頼んで終わる順がばらばらでも、時刻順に処理して、
// 手順と手の時刻は 1 か所で処理したときと同じ。ここでは Worker の代わりに、同じ検出を遅れて返す関数を使う
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { designOf } from "../src/aruco/design";
import { ARUCO_REFS } from "../src/aruco/palette";
import { MOVE_NAMES, type Vec3, applyMoves, parseMoves, solvedState } from "../src/cube/model";
import { type DetectHint, detectWithHint, detectorFor } from "../src/vision/arucoFrame";
import { ParallelFeeder } from "../src/vision/detectPool";
import { type CV, type PixelSource, initOpenCv } from "../src/vision/image";
import { Refiner } from "../src/vision/refine";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "./arucoCube";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

describe("精密解析の並列化", () => {
  it("検出が順不同に返っても、手順と手の時刻は同じ", async () => {
    const alg = "R U' F2 L";
    const truth = parseMoves(alg);
    const design = designOf("quad-half");
    const make = () => new Refiner(cv, { state: Array.from(solvedState()), refs: ARUCO_REFS, from: 0, to: Infinity, startHint: 300, pipeline: { stickers: "unique54", arucoDesign: "quad-half" } });
    const seq = make();
    const par = make();
    // 別の Worker の代わり: 検出の Worker と同じ設定（精密解析）で検出し、ばらばらの遅れで返す
    let n = 0;
    const detect = (img: PixelSource, hint: DetectHint | null) => {
      const copy = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
      const delay = [5, 0, 12, 3][n++ % 4];
      return new Promise<ReturnType<typeof detectWithHint>>((resolve) => setTimeout(() => resolve(detectWithHint(detectorFor(cv, "unique54", true, "quad-half"), copy, hint)), delay));
    };
    const feeder = new ParallelFeeder(par, detect, 4);
    const eye: Vec3 = [2.4, 2.4, 5.5];
    let st = solvedStickers();
    let done = 0;
    const lead = 300;
    const period = 500;
    const turnMs = 170;
    for (let t = 0; t <= lead + truth.length * period + 300; t += 1000 / 60) {
      while (done < truth.length && t >= lead + done * period + turnMs) st = applyMoveStickers(st, truth[done++]);
      const start = lead + done * period;
      const turning = done < truth.length && t >= start;
      const img = renderArucoCube(cv, { width: 960, height: 720, stickers: st, orient: 0, eye: [eye[0] + 0.03 * Math.sin(t / 400), eye[1], eye[2]], turn: turning ? { move: truth[done], fraction: (t - start) / turnMs, spread: 0.1 } : undefined, noise: 2, seed: Math.round(t), scheme: "unique54", design });
      seq.push(img, t);
      await feeder.push(img, t);
    }
    await feeder.flush();
    const target = applyMoves(solvedState(), truth);
    const a = seq.result(target);
    const b = par.result(target);
    expect(a.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe(alg);
    expect(b.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe(alg);
    b.moves.forEach((m, i) => {
      expect(Math.abs(m.start - a.moves[i].start)).toBeLessThanOrEqual(17);
      expect(Math.abs(m.end - a.moves[i].end)).toBeLessThanOrEqual(17);
    });
  }, 300000);
});
