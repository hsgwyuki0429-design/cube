// 見失ったところからの復帰（src/track/recover.ts）: 見失う前の状態から、後で読めたステッカーが全部合う手順を探す
import { describe, expect, it } from "vitest";
import { NUM_MOVES, VIEW, applyMove, solvedState, statesEqual } from "../src/cube/model";
import { stickerIds } from "../src/cube/stickers";
import { recoverFrom } from "../src/track/recover";
import type { Observation } from "../src/track/types";

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

// 姿勢 o で、正面・上・右の 3 面が全部読めた観測
function observe(state: Uint8Array, o: number, slots = [2, 0, 1]): Observation {
  const ids = stickerIds(state);
  return {
    t: 0,
    tPrevEnd: 0,
    faces: slots.map((slot) => {
      const fid = Int16Array.from({ length: 9 }, (_, c) => ids[VIEW[o * 54 + slot * 9 + c]]);
      return { slot, cost: new Float32Array(54), labels: Int8Array.from(fid, (s) => Math.floor(s / 9)), ids: fid, idCost: new Float32Array(9).fill(1) };
    }),
  };
}

describe("見失ったところからの復帰", () => {
  it("6〜8 手進んだ後の見え方から、本当の状態を候補に入れる", () => {
    const r = rng(3);
    let hit = 0;
    for (let n = 0; n < 12; n++) {
      let anchor = solvedState();
      for (let k = 0; k < 20; k++) anchor = applyMove(anchor, Math.floor(r() * NUM_MOVES));
      let truth = anchor;
      const len = 6 + (n % 3);
      for (let k = 0; k < len; k++) truth = applyMove(truth, Math.floor(r() * NUM_MOVES));
      const found = recoverFrom(anchor, observe(truth, 0), [0]);
      if (found?.some((f) => statesEqual(f.state, truth))) hit++;
    }
    // 見えている 3 面だけでは、見えていない所が違う別の手順が同じ長さで見つかることもある（そのときは候補が複数）
    expect(hit).toBeGreaterThanOrEqual(10);
  });
  it("見失っていない（0 手で合う）・読めたステッカーが少ないときは何も返さない", () => {
    const s = applyMove(applyMove(solvedState(), 3), 0);
    expect(recoverFrom(s, observe(s, 0), [0])).toEqual([]);
    expect(recoverFrom(s, observe(applyMove(s, 6), 0, [2]), [0])).toEqual([]);
  });
});
