import { describe, expect, it } from "vitest";
import { parseMoves } from "../src/cube/model";
import { EMPTY_CONTEXT, movePrior, shiftContext } from "../src/track/prior";

const ctxOf = (alg: string) => parseMoves(alg).reduce(shiftContext, EMPTY_CONTEXT);

describe("move prior", () => {
  it("charges extra only for moves that do not continue a known algorithm (any grip, mirrored)", () => {
    const t0 = performance.now();
    const p = movePrior();
    expect(performance.now() - t0).toBeLessThan(2000);
    // T-perm: R U R' U' R' F ... の F
    expect(p.penalty(ctxOf("U R' U'"), parseMoves("R'")[0])).toBe(0);
    // 同じ並びを F を前にして（U は同じ、R → F）
    expect(p.penalty(ctxOf("U F' U'"), parseMoves("F'")[0])).toBe(0);
    // 左手（鏡像）: L' U' L U
    expect(p.penalty(ctxOf("L' U' L"), parseMoves("U")[0])).toBe(0);
    // 手順にない 4 手の並び（3 手の並びとしてはどこかにあることもある）
    expect(p.penalty(ctxOf("D2 B L2"), parseMoves("F2")[0])).toBeGreaterThan(0.15);
    // 直前の手がなければ上乗せしない
    expect(p.penalty(EMPTY_CONTEXT, parseMoves("R")[0])).toBe(0);
  });

  it("learns personal sequences", () => {
    const own = parseMoves("D2 B L2 F2 D2 B L2 F2");
    expect(movePrior([own]).penalty(ctxOf("D2 B L2"), parseMoves("F2")[0])).toBe(0);
  });
});
