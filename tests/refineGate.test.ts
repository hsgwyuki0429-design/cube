// 精密解析の軽い検査（src/vision/refine.ts）: 前に精密に処理したフレームとマスの色が同じフレームは飛ばし、変わったフレームと
// その前後は精密に処理する。飛ばしても手順と手の時刻は変わらない
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { designOf } from "../src/aruco/design";
import { ARUCO_REFS } from "../src/aruco/palette";
import { MOVE_NAMES, type Vec3, applyMoves, parseMoves, solvedState } from "../src/cube/model";
import { type CV, initOpenCv } from "../src/vision/image";
import { Refiner } from "../src/vision/refine";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "./arucoCube";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

describe("精密解析の軽い検査", () => {
  it("止まっている間（少し揺れていても）は飛ばし、手順と手の時刻は全部を精密に処理したときと同じ", () => {
    const alg = "R U' F2";
    const truth = parseMoves(alg);
    const design = designOf("quad-half");
    const make = (gate: boolean) => new Refiner(cv, { state: Array.from(solvedState()), refs: ARUCO_REFS, from: 0, to: Infinity, startHint: 300, pipeline: { stickers: "unique54", arucoDesign: "quad-half" }, gate });
    const gated = make(true);
    const full = make(false);
    const eye: Vec3 = [2.4, 2.4, 5.5];
    let st = solvedStickers();
    let done = 0;
    const lead = 300;
    const period = 700; // 回したあと 0.5 秒ほど止まる
    const turnMs = 170;
    for (let t = 0; t <= lead + truth.length * period + 300; t += 1000 / 60) {
      while (done < truth.length && t >= lead + done * period + turnMs) st = applyMoveStickers(st, truth[done++]);
      const start = lead + done * period;
      const turning = done < truth.length && t >= start;
      const img = renderArucoCube(cv, {
        width: 960,
        height: 720,
        stickers: st,
        orient: 0,
        eye: [eye[0] + 0.03 * Math.sin(t / 400), eye[1], eye[2]],
        turn: turning ? { move: truth[done], fraction: (t - start) / turnMs, spread: 0.1 } : undefined,
        noise: 2,
        seed: Math.round(t),
        scheme: "unique54",
        design,
      });
      gated.push(img, t);
      full.push(img, t);
    }
    const target = applyMoves(solvedState(), truth);
    const a = gated.result(target);
    const b = full.result(target);
    expect(a.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe(alg);
    expect(b.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe(alg);
    expect(gated.gated).toBeGreaterThan(30);
    a.moves.forEach((m, i) => {
      expect(Math.abs(m.start - b.moves[i].start)).toBeLessThanOrEqual(17);
      expect(Math.abs(m.end - b.moves[i].end)).toBeLessThanOrEqual(17);
    });
  }, 300000);
});
