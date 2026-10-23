import { Alg } from "cubing/alg";
import { describe, expect, it } from "vitest";
import { MOVE_NAMES, applyMoves, solvedState } from "../src/cube/model";
import { analyzeState, loadKPuzzle, patternToState, stateToPattern } from "../src/cube/pattern";

function randomMoves(n: number, seed: number): number[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, () => Math.floor(rnd() * 18));
}

describe("KPattern conversion", () => {
  it("cubing.js の KPuzzle と同じ状態になる（往復も一致）", async () => {
    const kpuzzle = await loadKPuzzle();
    for (let k = 0; k < 60; k++) {
      const moves = randomMoves(k < 18 ? 1 : 22, k + 3);
      const alg = k < 18 ? MOVE_NAMES[k] : moves.map((m) => MOVE_NAMES[m]).join(" ");
      const ours = applyMoves(solvedState(), k < 18 ? [k] : moves);
      const theirs = kpuzzle.defaultPattern().applyAlg(new Alg(alg));
      const converted = await stateToPattern(ours);
      expect(converted.isIdentical(theirs), alg).toBe(true);
      expect(Array.from(patternToState(theirs)), alg).toEqual(Array.from(ours));
    }
  });

  it("壊れた状態を検出する", () => {
    const s = solvedState();
    // コーナーのステッカー1枚を入れ替え → ねじれ／ありえないピース
    const t = new Uint8Array(s);
    [t[8], t[2 * 9 + 2]] = [t[2 * 9 + 2], t[8]];
    expect(analyzeState(t).problems.length).toBeGreaterThan(0);
    // エッジ1つ反転
    const u = new Uint8Array(s);
    [u[7], u[2 * 9 + 1]] = [u[2 * 9 + 1], u[7]];
    expect(analyzeState(u).problems.map((p) => p.kind)).toContain("flip");
    expect(analyzeState(s).problems).toEqual([]);
  });
});
