import { describe, expect, it } from "vitest";
import { F2L, OLL, PLL, TRIGGERS, toCenterMoves } from "../src/cube/algorithms";
import { applyMoves, solvedState } from "../src/cube/model";

const S = solvedState();
// 側面（R F L B）の段 r のステッカーが揃ったままか
const sideRowKept = (s: Uint8Array, r: number) => [1, 2, 4, 5].every((f) => [0, 1, 2].every((c) => s[f * 9 + r * 3 + c] === f));
const f2lKept = (s: Uint8Array) => sideRowKept(s, 1) && sideRowKept(s, 2) && [...Array(9).keys()].every((i) => s[27 + i] === 3);
const crossKept = (s: Uint8Array) => [1, 3, 5, 7].every((i) => s[27 + i] === 3) && [1, 2, 4, 5].every((f) => s[f * 9 + 7] === f);

describe("algorithm library", () => {
  it("PLLs only permute the last layer (top face stays one colour)", () => {
    for (const a of PLL) {
      const s = applyMoves(S, toCenterMoves(a));
      expect(f2lKept(s), a).toBe(true);
      expect([...s.slice(0, 9)].every((c) => c === 0), a).toBe(true);
      expect([...s].some((c, i) => c !== S[i]), a).toBe(true);
    }
  });

  it("OLLs keep the first two layers", () => {
    for (const a of OLL) expect(f2lKept(applyMoves(S, toCenterMoves(a))), a).toBe(true);
  });

  it("F2L inserts keep the cross", () => {
    for (const a of F2L) expect(crossKept(applyMoves(S, toCenterMoves(a))), a).toBe(true);
  });

  it("converts wide, slice and rotation moves to centre-fixed face turns", () => {
    expect(toCenterMoves("R U R' U'")).toEqual([3, 0, 5, 2]);
    expect(TRIGGERS.length).toBeGreaterThan(0);
    // x の後は前の面が上に来るので、U は元の F を回す
    expect(toCenterMoves("x U x'")).toEqual(toCenterMoves("F"));
    expect(toCenterMoves("y R y'")).toEqual(toCenterMoves("B"));
    expect(toCenterMoves("z U z'")).toEqual(toCenterMoves("L"));
    expect(toCenterMoves("r")).toEqual(toCenterMoves("L"));
    expect(toCenterMoves("r U")).toEqual(toCenterMoves("L F"));
    expect(toCenterMoves("M2 U M2")).toEqual(toCenterMoves("R2 L2 D R2 L2"));
  });
});
