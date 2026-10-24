// 色の読み → 物理的にありえる最も近い状態
import { describe, expect, it } from "vitest";
import { applyMoves, solvedState } from "../src/cube/model";
import { analyzeState, mostLikelyState } from "../src/cube/pattern";
import { rng, scrambled } from "./sim";

describe("mostLikelyState", () => {
  it("returns the state itself when the readings are exact", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = scrambled(rng(seed));
      const r = mostLikelyState((i, c) => (s[i] === c ? 0 : 10));
      expect(Array.from(r.state)).toEqual(Array.from(s));
      expect(r.cost).toBe(0);
    }
  });

  it("fixes a misread sticker using piece constraints (white read as yellow)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = scrambled(rng(seed));
      // 1 枚だけ別の色に読めている（ただし本当の色との差は小さい）
      const bad = [0, 1, 2, 3, 5, 6, 7, 8].map((k) => 9 * (seed % 6) + k)[seed % 8];
      const wrong = (s[bad] + 1 + (seed % 5)) % 6;
      const r = mostLikelyState((i, c) => {
        if (i === bad) return c === wrong ? 0 : c === s[i] ? 3 : 20;
        return s[i] === c ? 0 : 20;
      });
      expect(analyzeState(r.state).problems).toEqual([]);
      expect(Array.from(r.state)).toEqual(Array.from(s));
    }
  });

  it("always returns a valid state even from garbage readings", () => {
    const rnd = rng(7);
    for (let k = 0; k < 10; k++) {
      const costs = Array.from({ length: 54 * 6 }, () => rnd() * 30);
      const r = mostLikelyState((i, c) => costs[i * 6 + c]);
      expect(analyzeState(r.state).problems).toEqual([]);
    }
    void applyMoves;
    void solvedState;
  });
});
