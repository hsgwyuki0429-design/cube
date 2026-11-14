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

  it("光らせる印: 次のペアだけふつう、クロスと入ったスロットは暗く、ほかは灰色", () => {
    const start = applyMoves(solvedState(), parseMoves("R U' R'"));
    const plan = f2lPlan(start, parseMoves("R U R'"), 3);
    const mask = f2lMask(3, plan[0])!;
    expect(mask).toMatch(/^EDGES:[-DI]{12},CORNERS:[-DI]{8},CENTERS:D{6}$/);
    const edges = mask.slice(6, 18); // UF UR UB UL DF DR DB DL FR FL BR BL
    const corners = mask.split(",")[1].slice(8); // UFR URB UBL ULF DRF DFL DLB DBR
    expect(edges).toBe("IIIIDDDD-DDD");
    expect(corners).toBe("IIII-DDD");
    expect(f2lMask(3, null)).toBeNull();
  });
});
