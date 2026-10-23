import { describe, expect, it } from "vitest";
import { applyMoves, isSolved, solvedState, statesEqual } from "../src/cube/model";
import { randomScramble, setupMovesFor, solveBetween, solveState } from "../src/cube/solver";

describe("solver (cubing.js)", () => {
  it("スクランブルを解ける・セットアップ手順で同じ状態を作れる", async () => {
    const scramble = await randomScramble();
    expect(scramble.length).toBeGreaterThan(10);
    const s = applyMoves(solvedState(), scramble);
    const sol = await solveState(s);
    expect(isSolved(applyMoves(s, sol))).toBe(true);
    const setup = await setupMovesFor(s);
    expect(statesEqual(applyMoves(solvedState(), setup), s)).toBe(true);
  });

  it("状態 A から状態 B への手順", async () => {
    const a = applyMoves(solvedState(), "R U R' U' F2 D L");
    const b = applyMoves(solvedState(), "B2 L' U D2 R F'");
    const x = await solveBetween(a, b);
    expect(statesEqual(applyMoves(a, x), b)).toBe(true);
  });
});
