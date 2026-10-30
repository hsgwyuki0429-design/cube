// ステッカーの同一性（src/cube/stickers.ts）: 色の状態から求めた各 facelet のステッカーが、ステッカーを 3D で動かした結果と一致する
import { describe, expect, it } from "vitest";
import { MOVE_NAMES, VIEW, applyMoves, parseMoves, solvedState } from "../src/cube/model";
import { PARTNERS, stickerIds } from "../src/cube/stickers";
import { MoveDecoder } from "../src/track/decoder";
import { FaceObserver } from "../src/track/observer";
import { ColorModel } from "../src/track/colorModel";
import type { Observation } from "../src/track/types";
import { ARUCO_REFS } from "../src/aruco/palette";
import { applyMoveStickers, solvedStickers, stickerAt } from "./arucoCube";

describe("ステッカーの同一性", () => {
  it("揃った状態では各 facelet が自分自身", () => {
    expect(Array.from(stickerIds(solvedState()))).toEqual(Array.from({ length: 54 }, (_, i) => i));
    expect(PARTNERS.filter((p) => p.length === 0).length).toBe(6);
    expect(PARTNERS.filter((p) => p.length === 1).length).toBe(24);
    expect(PARTNERS.filter((p) => p.length === 2).length).toBe(24);
  });

  for (const alg of ["R", "U F' L2", "R U R' U' R' F R2 U' R' U' R U R' F'", "B2 D L' F U2 R' B D2 L U'"]) {
    it(`${alg}: ステッカーを 3D で動かした結果と同じ`, () => {
      let st = solvedStickers();
      for (const m of parseMoves(alg)) st = applyMoveStickers(st, m);
      expect(Array.from(stickerIds(applyMoves(solvedState(), alg)))).toEqual(stickerAt(st));
    });
  }
});

// 正面（姿勢 0 のカメラの正面 = F）だけが見えている観測。withIds: 読んだステッカーも付ける
function frontObs(alg: string, t: number, withIds: boolean): Observation {
  const s = applyMoves(solvedState(), alg);
  const ids = stickerIds(s);
  const cost = new Float32Array(54);
  const labels = new Int8Array(9);
  const seen = new Int16Array(9);
  for (let cell = 0; cell < 9; cell++) {
    const f = VIEW[2 * 9 + cell];
    labels[cell] = s[f];
    seen[cell] = ids[f];
    for (let c = 0; c < 6; c++) cost[cell * 6 + c] = c === s[f] ? 0 : 1.5;
  }
  const face = withIds ? { slot: 2, cost, labels, ids: seen, idCost: new Float32Array(9).fill(1) } : { slot: 2, cost, labels };
  return { t, tPrevEnd: t - 50, faces: [face] };
}

describe("読んだステッカーをデコーダの観測に使う", () => {
  it("揃った状態で正面だけを回す（F）: 色では変化が見えないが、ステッカーの並びで分かる", () => {
    for (const [withIds, want] of [
      [false, ""],
      [true, "F"],
    ] as const) {
      const dec = new MoveDecoder(solvedState(), {}, [0]);
      dec.observe(frontObs("", 0, withIds));
      dec.observe(frontObs("F", 300, withIds));
      expect(dec.bestMoves().map((m) => MOVE_NAMES[m.move]).join(" ")).toBe(want);
    }
  });

  it("観測器: 安定した読みのステッカーを観測に載せ、色が同じでもステッカーが変われば観測を出す", () => {
    const obs = new FaceObserver(new ColorModel(ARUCO_REFS), { stableFrames: 2, minKnown: 2, minSideKnown: 1 });
    const reading = (alg: string, t: number) => {
      const s = applyMoves(solvedState(), alg);
      const ids = stickerIds(s);
      const cells = Array.from({ length: 9 }, (_, c) => VIEW[2 * 9 + c]);
      return { t, faces: [{ slot: 2, labs: cells.map((f) => ARUCO_REFS[s[f]]), valid: cells.map(() => true), ids: cells.map((f) => ids[f]) }] };
    };
    const out: Observation[] = [];
    for (const [alg, t] of [
      ["", 0],
      ["", 33],
      ["", 66],
      ["F", 300],
      ["F", 333],
    ] as const) {
      const o = obs.push(reading(alg, t));
      if (o) out.push(o);
    }
    expect(out.length).toBe(2);
    expect(Array.from(out[1].faces[0].ids!)).toEqual(Array.from({ length: 9 }, (_, c) => stickerIds(applyMoves(solvedState(), "F"))[VIEW[2 * 9 + c]]));
  });
});
