// X クロスの最短（src/cube/xcross.ts）: 揃うこと・総当たりと同じ手数・ランダムなスクランブルで時間内に解けること
import { describe, expect, it } from "vitest";
import { crossDone } from "../src/cube/analysis";
import { type CubeState, NUM_MOVES, applyMove, applyMoves, moveFace, solvedState } from "../src/cube/model";
import { PARTNERS } from "../src/cube/stickers";
import { solveXCross } from "../src/cube/xcross";

const home = (s: CubeState, f: number) => s[f] === Math.floor(f / 9);
// 面 c のクロスと、面 c の上のコーナー k のペア（コーナーとその間のエッジ）が揃っているか
function xcrossDone(s: CubeState, c: number, k: number): boolean {
  if (!crossDone(s, c)) return false;
  const corner = c * 9 + k;
  const facelets = [corner, ...PARTNERS[corner]];
  const [a, b] = PARTNERS[corner].map((f) => Math.floor(f / 9));
  for (let f = 0; f < 54; f++) if (PARTNERS[f].length === 1 && ((Math.floor(f / 9) === a && Math.floor(PARTNERS[f][0] / 9) === b) || (Math.floor(f / 9) === b && Math.floor(PARTNERS[f][0] / 9) === a))) facelets.push(f);
  return facelets.every((f) => home(s, f));
}
const anySlot = (s: CubeState, c: number) => [0, 2, 6, 8].some((k) => xcrossDone(s, c, k));

function rng(seed: number) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
function randomMoves(n: number, r: () => number): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const m = Math.floor(r() * NUM_MOVES);
    if (out.length && moveFace(out[out.length - 1]) === moveFace(m)) continue;
    out.push(m);
  }
  return out;
}

// 総当たり: depth 手以内でいちばん短い X クロスの手数
function bruteForce(s: CubeState, c: number, depth: number): number {
  let frontier = [s];
  if (anySlot(s, c)) return 0;
  for (let d = 1; d <= depth; d++) {
    const next: CubeState[] = [];
    for (const x of frontier) for (let m = 0; m < NUM_MOVES; m++) next.push(applyMove(x, m));
    if (next.some((x) => anySlot(x, c))) return d;
    frontier = next;
  }
  return Infinity;
}

describe("X クロスの最短", () => {
  it("揃った状態は 0 手", () => {
    expect(solveXCross(solvedState(), 3)?.moves).toEqual([]);
  });

  it("4 手以内の崩しでは、総当たりと同じ手数", () => {
    const r = rng(7);
    for (let i = 0; i < 12; i++) {
      const c = i % 6;
      const s = applyMoves(solvedState(), randomMoves(4, r));
      const res = solveXCross(s, c)!;
      expect(anySlot(applyMoves(s, res.moves), c)).toBe(true);
      expect(res.moves.length).toBe(bruteForce(s, c, 4));
    }
  });

  it("ランダムなスクランブルでも揃う（時間の目安を出す）", () => {
    const r = rng(11);
    const t0 = performance.now();
    const lens: number[] = [];
    for (let i = 0; i < 6; i++) {
      const c = [0, 3][i % 2];
      const s = applyMoves(solvedState(), randomMoves(25, r));
      const res = solveXCross(s, c)!;
      expect(res).not.toBeNull();
      expect(xcrossDone(applyMoves(s, res.moves), c, [0, 2, 6, 8][res.slot])).toBe(true);
      lens.push(res.moves.length);
    }
    process.stdout.write(`X クロスの手数 ${lens.join(",")}・計 ${(performance.now() - t0).toFixed(0)}ms\n`);
  }, 120000);
});
