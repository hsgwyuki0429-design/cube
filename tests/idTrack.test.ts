// ID なし追跡（src/aruco/idTrack.ts）: 指が動いて読めなくなったマスに、直前に読めていたステッカーを引き継ぐ。層を回したときは引き継がない
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { IdTracker, LAYER_CELLS } from "../src/aruco/idTrack";
import { VIEW, type Vec3, parseMoves } from "../src/cube/model";
import { applyH } from "../src/vision/homography";
import { processAruco } from "../src/vision/arucoFrame";
import { type CV, initOpenCv } from "../src/vision/quads";
import { applyMoveStickers, renderArucoCube, solvedStickers, stickerAt } from "./arucoCube";
import type { Finger } from "./render";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

const SIZE = { width: 960, height: 720 };
const EYE: Vec3 = [2.4, 2.4, 5.5];

describe("ID なし追跡", () => {
  it("回す層のマス: 上の層を回すと、上の面全部と側面の上の段", () => {
    expect(LAYER_CELLS[0].size).toBe(21);
    for (let c = 0; c < 9; c++) expect(LAYER_CELLS[0].has(c)).toBe(true);
    for (const slot of [1, 2, 4, 5]) for (const c of [0, 1, 2]) expect(LAYER_CELLS[0].has(slot * 9 + c)).toBe(true);
    expect(LAYER_CELLS[0].has(2 * 9 + 3)).toBe(false);
  });

  // 30fps で、指先が正面の左から右へ横切る（キューブは止まっている）。途中で R を回す（turnAt: 回し始めのフレーム、3 フレームでぶれながら）
  function run(track: boolean, turnAt?: number) {
    let st = solvedStickers();
    for (const m of parseMoves("R U F' D2 L")) st = applyMoveStickers(st, m);
    const clean = processAruco(cv, renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: EYE, noise: 2, scheme: "unique54" }), 0, {}, "unique54", false, { idTrack: false });
    const front = clean.faces.find((f) => f.slot === 2)!;
    const pitch = Math.hypot(applyH(front.H, 1, 0)[0] - applyH(front.H, 0, 0)[0], applyH(front.H, 1, 0)[1] - applyH(front.H, 0, 0)[1]);
    const memory = {};
    const R = parseMoves("R")[0];
    const out = { correct: 0, wrong: 0, readOnly: 0, frames: 0 };
    for (let k = 0; k < 16; k++) {
      const t = k * 33;
      if (turnAt !== undefined && k === turnAt + 3) st = applyMoveStickers(st, R);
      const turning = turnAt !== undefined && k >= turnAt && k < turnAt + 3 ? { move: R, fraction: (k - turnAt + 0.5) / 3, spread: 0.3 } : undefined;
      // 指先: 正面の中段を左から右へ。指は下から
      const tip = applyH(front.H, 0.3 + (k / 15) * 2.4, 1.2 + 0.3 * Math.sin(k));
      const fingers: Finger[] = [{ a: [tip[0] - pitch * 0.5, tip[1] + pitch * 3.5], b: [tip[0], tip[1]], width: pitch * 0.85 }];
      const img = renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: EYE, noise: 2, seed: k + 1, scheme: "unique54", fingers, turn: turning });
      const r = processAruco(cv, img, t, memory, "unique54", false, { idTrack: track, colorFill: false, reread: 0 });
      const at = stickerAt(st);
      const f = r.faces.find((x) => x.slot === 2);
      // 正面が指でほぼ隠れると、右の面が正面に割り当たることがある（frontAlways）。そのフレームは数えない
      if (!f || turning || (f.ids && f.ids[4] >= 0 && f.ids[4] !== 22)) continue;
      out.frames++;
      f.ids?.forEach((id, cell) => {
        if (id < 0) return;
        if (id === at[VIEW[2 * 9 + cell]]) out.correct++;
        else out.wrong++;
      });
    }
    return out;
  }

  it("指が横切っても、読めなくなった正面のマスのステッカーを引き継ぐ（誤りなし）", () => {
    const without = run(false);
    const withTrack = run(true);
    expect(withTrack.wrong).toBe(0);
    expect(withTrack.correct).toBeGreaterThan(without.correct + 10);
  }, 300000);

  it("途中で R を回しても、回した後に前のステッカーを誤って引き継がない", () => {
    const r = run(true, 6);
    expect(r.wrong).toBe(0);
  }, 300000);

  it("IdTracker: 同じ面の読めたマスが前のフレームと食い違えば、その面は引き継がない", () => {
    const H = [100, 0, 100, 0, 100, 100, 0, 0, 1];
    const face = (ids: number[]) => ({ slot: 2, colors: ids.map((id) => (id >= 0 ? Math.floor(id / 9) : -1)), ids, conf: ids.map((id) => (id >= 0 ? 1 : 0)), outline: [], H });
    const tr = new IdTracker();
    tr.update(0, [face([18, 19, 20, 21, 22, 23, 24, 25, 26])]);
    // 1 マス読めなくなった: 引き継ぐ
    const a = face([18, -1, 20, 21, 22, 23, 24, 25, 26]);
    expect(tr.update(33, [a]).size).toBe(1);
    expect(a.ids[1]).toBe(19);
    // 別のマスのステッカーが変わった（見えないうちに回した）: 引き継がない
    const b = face([20, -1, 26, 21, 22, 23, 24, 25, 18]);
    expect(tr.update(66, [b]).size).toBe(0);
    expect(b.ids[1]).toBe(-1);
  });
});
