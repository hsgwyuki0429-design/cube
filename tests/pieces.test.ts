import { describe, expect, it } from "vitest";
import { NUM_MOVES, applyMove, parseMoves, solvedState, statesEqual } from "../src/cube/model";
import { stickerIds } from "../src/cube/stickers";
import { DIST, EXPECT_ROT, PERM, PIECE_OF, PIECE_REF, REF_AT, fromCubeState, toCubeState } from "../src/track/pieces/model";

describe("ピースごとのモデル", () => {
  it("ランダムな手順で、54 枚の状態と同じになる", () => {
    let s = solvedState();
    const p = fromCubeState(s);
    let seed = 7;
    for (let i = 0; i < 300; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const m = seed % NUM_MOVES;
      s = applyMove(s, m);
      for (let k = 0; k < 20; k++) p.pos[k] = PERM[m][p.pos[k]];
      expect(statesEqual(toCubeState(p.pos), s)).toBe(true);
      const q = fromCubeState(s);
      expect(Array.from(q.pos)).toEqual(Array.from(p.pos));
      // どのステッカーの位置からも、代表の位置が出る
      const ids = stickerIds(s);
      for (let f = 0; f < 54; f++) if (PIECE_OF[ids[f]] >= 0) expect(REF_AT[ids[f] * 54 + f]).toBe(p.pos[PIECE_OF[ids[f]]]);
    }
  });
  it("揃った状態ではマーカーは上向き・1 手で届く位置は距離 1", () => {
    for (let s = 0; s < 54; s++) if (PIECE_OF[s] >= 0) expect(EXPECT_ROT[s * 54 + s]).toBe(0);
    for (const k of PIECE_REF) for (let m = 0; m < NUM_MOVES; m++) expect(DIST[k * 54 + PERM[m][k]]).toBeLessThanOrEqual(1);
    // U を回すと、U の面のステッカーは時計回りに 90° 回る
    const u = parseMoves("U")[0];
    expect(EXPECT_ROT[0 * 54 + PERM[u][0]]).toBe(1);
  });
});

import { CELL_TURN, NEIGHBOR } from "../src/track/pieces/model";
describe("面の置き方", () => {
  it("格子を回して読んでも、マーカーの向きの関係が保たれる", () => {
    for (let s = 0; s < 54; s++) {
      if (PIECE_OF[s] < 0) continue;
      for (let c = 0; c < 9; c++) {
        const e = EXPECT_ROT[s * 54 + c];
        if (e < 0) continue;
        for (let r = 0; r < 4; r++) expect(EXPECT_ROT[s * 54 + CELL_TURN[r * 9 + c]]).toBe((e - r + 4) & 3);
      }
    }
  });
  it("隣の面は互いに隣", () => {
    for (let i = 0; i < 24; i++) expect(NEIGHBOR[NEIGHBOR[i]]).toBe(i);
  });
});
