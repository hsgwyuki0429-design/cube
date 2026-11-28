import { describe, expect, it } from "vitest";
import { PLL, toCenterMoves } from "../src/cube/algorithms";
import { D, U, applyMoves, invertMoves, solvedState } from "../src/cube/model";
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
