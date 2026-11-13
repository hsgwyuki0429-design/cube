import { describe, expect, it } from "vitest";
import { f2lMask, f2lPlan, slotsFor } from "../src/cube/f2l";
import { applyMoves, parseMoves, solvedState } from "../src/cube/model";

describe("F2L のスロット", () => {
  it("クロスの面ごとに 4 つ", () => {
    for (let c = 0; c < 6; c++) expect(slotsFor(c)).toHaveLength(4);
  });

  it("次に入るスロットと入った手", () => {
    // 黄（D）クロスで、FR のスロットを崩して戻す
    const start = applyMoves(solvedState(), parseMoves("R U' R'"));
    const moves = parseMoves("R U R'");
    const plan = f2lPlan(start, moves, 3);
    expect(plan).toHaveLength(4);
    expect(plan[0]?.slot).toEqual([1, 2]); // R と F
    expect(plan[0]?.doneAt).toBe(3);
    expect(plan[0]?.solved).toHaveLength(3);
    expect(plan[3]).toBeNull(); // F2L が済んだ後
  });

  it("光らせる印: 次のペアとクロス・入ったスロットはふつう、最後の段は暗く", () => {
    const start = applyMoves(solvedState(), parseMoves("R U' R'"));
    const plan = f2lPlan(start, parseMoves("R U R'"), 3);
    const mask = f2lMask(3, plan[0]);
    expect(mask).toMatch(/^EDGES:[-D]{12},CORNERS:[-D]{8},CENTERS:------$/);
    // U の段のエッジ（UF UR UB UL）・コーナー（最初の 4 つ）は暗い
    expect(mask!.slice(6, 10)).toBe("DDDD");
    expect(mask!.split(",")[1].slice(8, 12)).toBe("DDDD");
    // D の段のエッジ（クロス）と中段のエッジはふつう
    expect(mask!.slice(10, 18)).toBe("--------");
    expect(f2lMask(3, null)).toBeNull();
  });
});
