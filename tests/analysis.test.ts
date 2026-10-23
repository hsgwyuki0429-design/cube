import { describe, expect, it } from "vitest";
import { applyMoves, invertMoves, parseMoves, solvedState, D } from "../src/cube/model";
import { cfopSplits, crossDone, f2lDone } from "../src/cube/analysis";

describe("CFOP splits", () => {
  it("完成状態はすべて満たす", () => {
    const s = solvedState();
    for (let c = 0; c < 6; c++) {
      expect(crossDone(s, c)).toBe(true);
      expect(f2lDone(s, c)).toBe(true);
    }
  });

  it("PLL だけ崩した状態: クロス・F2L・OLL は開始時点で済み", () => {
    const tperm = parseMoves("R U R' U' R' F R2 U' R' U' R U R' F'");
    const start = applyMoves(solvedState(), invertMoves(tperm));
    const splits = cfopSplits(start, tperm)!;
    expect(splits.map((s) => s.index)).toEqual([0, 0, 0, tperm.length]);
  });

  it("スクランブル＋逆手順でも区切りが単調", () => {
    const scr = parseMoves("R U2 F' L D2 B R' U F2 D' L2 U B2 R2 D F2 U' L2");
    const start = applyMoves(solvedState(), scr);
    const sol = invertMoves(scr);
    const splits = cfopSplits(start, sol)!;
    const idx = splits.map((s) => s.index);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(idx[3]).toBe(sol.length);
    // 底面 D のクロスは D を崩さない手順なら最初から
    expect(crossDone(applyMoves(solvedState(), "U R U' R'"), D)).toBe(true);
    expect(crossDone(applyMoves(solvedState(), "R"), D)).toBe(false);
  });
});
