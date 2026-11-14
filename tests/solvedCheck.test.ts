// 「揃った状態から開始」の後の確かめ（src/app/solvedCheck.ts）: 揃っていれば 2 面ほどですぐ、揃っていなければ 6 面を見せた後に、
// 読み取った状態（本当の状態）からスクランブルを作れること
import { describe, expect, it } from "vitest";
import { ARUCO_REFS } from "../src/aruco/palette";
import { CHECK_STICKERS, type CheckMemo, checkStep } from "../src/app/solvedCheck";
import { B, D, F, L, R, U, VIEW, applyMoves, parseMoves, solvedState, statesEqual } from "../src/cube/model";
import { stickerIds } from "../src/cube/stickers";
import type { Observation } from "../src/track/types";
import { TrackerEngine } from "../src/track/engine";
import { observe, rng } from "./sim";

const clean = { misread: 0, hidden: 0, mismatchCost: 1.5 };
const LIVE = { snapToView: true, recover: true, decoder: { beamWidth: 64, priorWeight: 0, confirmMargin: 1, deepHyps: 4, bridgeDepth: 5 } };

// 姿勢 o でカメラの正面・上・右に見える、ID 付きの観測
function seen(state: Uint8Array, o: number, t: number): Observation {
  const obs = observe(state, o, [F, U, R], t, t - 100, rng(t), clean);
  const ids = stickerIds(state);
  for (const f of obs.faces) {
    f.ids = Int16Array.from({ length: 9 }, (_, cell) => ids[VIEW[(o * 6 + f.slot) * 9 + cell]]);
    f.idCost = new Float32Array(9).fill(1);
  }
  return obs;
}

// カメラの正面・上・右に、キューブの面 faces（順は問わない）が見える姿勢
function orientShowing(...faces: number[]): number {
  for (let o = 0; o < 24; o++) {
    const shown = [F, U, R].map((slot) => Math.floor(VIEW[(o * 6 + slot) * 9 + 4] / 9)).sort();
    if (shown.join() === [...faces].sort().join()) return o;
  }
  throw new Error("no orientation");
}

describe("揃っているかの確かめ", () => {
  it("揃っていれば、2〜3 面が見えた時点でスクランブルへ", () => {
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS, LIVE);
    let memo: CheckMemo | null = null;
    let ready = false;
    for (let t = 100; t <= 400 && !ready; t += 100) {
      const r = checkStep(engine.observe(seen(solvedState(), 0, t)), memo);
      memo = r.memo;
      ready = r.step.ready;
      expect(r.step.unsolved).toBe(false);
    }
    expect(ready).toBe(true);
  });

  it("揃っていなければ、6 面を見せるまで待ち、読み取った状態は本当の状態", () => {
    const truth = applyMoves(solvedState(), parseMoves("R U2 F' L D B2 R' U F2 D' L'"));
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS, LIVE);
    const front = orientShowing(F, U, R);
    const back = orientShowing(B, D, L);
    let memo: CheckMemo | null = null;
    let t = 100;
    const show = (o: number, n: number) => {
      let last = null;
      for (let k = 0; k < n; k++, t += 100) {
        const u = engine.observe(seen(truth, o, t));
        const r = checkStep(u, memo);
        memo = r.memo;
        last = { u, step: r.step };
        if (r.step.ready) break;
      }
      return last!;
    };
    // 正面・上・右だけ: 揃っていないと分かるが、まだ作れない
    let r = show(front, 6);
    expect(r.step.unsolved).toBe(true);
    expect(r.step.ready).toBe(false);
    expect(r.step.left).toBeGreaterThan(0);
    // 裏の 3 面も見せる（作り変えたら、その後にもう一度ひと回り見せる）
    for (let round = 0; round < 4 && !r.step.ready; round++) {
      r = show(back, 6);
      if (!r.step.ready) r = show(front, 6);
    }
    expect(r.step.ready).toBe(true);
    expect(r.step.left).toBe(0);
    expect(r.step.seen).toBe(CHECK_STICKERS);
    expect(statesEqual(Uint8Array.from(r.u.state), truth)).toBe(true);
  });
});
