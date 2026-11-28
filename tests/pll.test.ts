import { describe, expect, it } from "vitest";
import { PLL, toCenterMoves } from "../src/cube/algorithms";
import { cfopPhases, cfopSplits } from "../src/cube/analysis";
import { D, U, applyMoves, invertMoves, parseMoves, solvedState } from "../src/cube/model";
import { pllName } from "../src/cube/pll";

const NAMES = ["T", "Jb", "Ja", "Y", "F", "Aa", "Ab", "E", "H", "Ua", "Ub", "Ua", "Ub", "Z", "Ra", "Rb", "Na", "Nb", "V", "Ga", "Gb", "Gc", "Gd"];

describe("PLL の名前", () => {
  it("PLL の手順の逆で崩した状態を、その名前で見分ける（AUF・持ち方を変えても）", () => {
    PLL.forEach((alg, i) => {
      for (const [hold, cross] of [["x2", U], ["", D], ["x2 y", U], ["y'", D]] as const)
        for (const auf of ["", "U", "U2", "U'"]) {
          const moves = toCenterMoves(`${hold} ${auf} ${alg}`);
          const s = applyMoves(solvedState(), invertMoves(moves));
          expect(pllName(s, cross), `${NAMES[i]} ${hold} ${auf}`).toBe(NAMES[i]);
        }
    });
  });

  it("AUF だけなら skip、PLL でなければ null", () => {
    expect(pllName(applyMoves(solvedState(), "D"), U)).toBe("skip");
    expect(pllName(solvedState(), U)).toBe("skip");
    expect(pllName(applyMoves(solvedState(), "R U R' U'"), U)).toBe(null);
  });
});

describe("CFOP の区切り（F2L 1〜4）", () => {
  it("区切りは単調で、F2L 4 と最後は cfopSplits と同じ", () => {
    const scr = parseMoves("R U2 F' L D2 B R' U F2 D' L2 U B2 R2 D F2 U' L2");
    const start = applyMoves(solvedState(), scr);
    const sol = invertMoves(scr);
    const r = cfopPhases(start, sol)!;
    const idx = r.phases.map((p) => p.index);
    expect(r.phases.map((p) => p.name)).toEqual(["クロス", "F2L 1", "F2L 2", "F2L 3", "F2L 4", "OLL", "PLL"]);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    const sp = cfopSplits(start, sol)!.map((x) => x.index);
    expect([idx[0], idx[4], idx[5], idx[6]]).toEqual(sp);
  });

  it("PLL だけの崩し: クロス〜OLL は 0 手", () => {
    const tperm = parseMoves("R U R' U' R' F R2 U' R' U' R U R' F'");
    const r = cfopPhases(applyMoves(solvedState(), invertMoves(tperm)), tperm)!;
    expect(r.phases.map((p) => p.index)).toEqual([0, 0, 0, 0, 0, 0, tperm.length]);
  });
});
