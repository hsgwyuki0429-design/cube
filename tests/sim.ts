// デコーダのシミュレーション用ヘルパ（テスト専用）
import { NUM_MOVES, OPPOSITE, VIEW, applyMove, moveFace, solvedState, type CubeState } from "../src/cube/model";
import type { FaceObservation, Observation } from "../src/track/types";

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export interface NoiseOptions {
  misread: number; // 誤読の確率
  hidden: number; // 不明（手で隠れた）確率
  mismatchCost: number;
}

export function observe(state: CubeState, orient: number, slots: number[], t: number, tPrevEnd: number, rnd: () => number, noise: NoiseOptions): Observation {
  const faces: FaceObservation[] = slots.map((slot) => {
    const cost = new Float32Array(54);
    const labels = new Int8Array(9);
    for (let cell = 0; cell < 9; cell++) {
      const truth = state[VIEW[(orient * 6 + slot) * 9 + cell]];
      if (rnd() < noise.hidden) {
        labels[cell] = -1;
        continue;
      }
      let seen = truth;
      if (rnd() < noise.misread) seen = (truth + 1 + Math.floor(rnd() * 5)) % 6;
      labels[cell] = seen;
      for (let c = 0; c < 6; c++) cost[cell * 6 + c] = c === seen ? 0 : noise.mismatchCost;
    }
    return { slot, cost, labels };
  });
  return { t, tPrevEnd, faces };
}

export function randomMove(rnd: () => number, prev: number | undefined, allowed: number[]): number {
  for (;;) {
    const m = allowed[Math.floor(rnd() * allowed.length)];
    if (prev === undefined || moveFace(m) !== moveFace(prev)) return m;
  }
}

// 連続する同じ面をまとめ、隣り合う反対面の順序を正規化する（同じ状態になる手順を同一視する）
export function canonical(moves: number[]): number[] {
  const out: number[] = [];
  for (const m of moves) {
    const last = out[out.length - 1];
    if (last !== undefined && moveFace(last) === moveFace(m)) {
      const amt = (((last % 3) + 1 + (m % 3) + 1) % 4);
      out.pop();
      if (amt) out.push(moveFace(m) * 3 + amt - 1);
      continue;
    }
    out.push(m);
  }
  for (let pass = 0; pass < out.length; pass++) {
    for (let i = 0; i + 1 < out.length; i++) {
      const a = moveFace(out[i]);
      const b = moveFace(out[i + 1]);
      if (OPPOSITE[a] === b && a > b) [out[i], out[i + 1]] = [out[i + 1], out[i]];
    }
  }
  return out;
}

export function editDistance(a: number[], b: number[]): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export const ALL_MOVES = Array.from({ length: NUM_MOVES }, (_, i) => i);

export function scrambled(rnd: () => number, n = 25): CubeState {
  let s = solvedState();
  let prev: number | undefined;
  for (let i = 0; i < n; i++) {
    prev = randomMove(rnd, prev, ALL_MOVES);
    s = applyMove(s, prev);
  }
  return s;
}
