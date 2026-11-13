// ピースの時刻表（src/track/pieces）: 合成した読み（正面・上・右の 3 面が見えるキューブ）から手順を解く
import { describe, expect, it } from "vitest";
import { type CubeState, NUM_MOVES, applyMove, inverseMove, solvedState } from "../src/cube/model";
import { stickerIds } from "../src/cube/stickers";
import { decodePieces } from "../src/track/pieces/decode";
import type { SightFace, SightFrame } from "../src/track/pieces/frame";
import { EXPECT_ROT } from "../src/track/pieces/model";
import { buildTable } from "../src/track/pieces/table";
import { canonical } from "../src/track/rescore";

// 面（キューブの面 = カメラの面: 姿勢 0）の外枠。上の面は正面の上、右の面は正面の右に開いた形
const QUADS: Record<number, number[]> = { 0: [100, 0, 200, 0, 200, 100, 100, 100], 2: [100, 100, 200, 100, 200, 200, 100, 200], 1: [200, 100, 300, 100, 300, 200, 200, 200] };

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// 状態と、面ごとに回した回数から 1 フレームの読みを作る。hide: 隠すマス（面 * 9 + マス）
function frame(t: number, state: CubeState, turns: number[], hide = new Set<number>(), faces = [2, 0, 1]): SightFrame {
  const ids = stickerIds(state);
  const out: SightFace[] = [];
  for (const f of faces) {
    const face: SightFace = { slot: f, ids: new Array(9).fill(-1), rot: new Array(9).fill(-1), quad: QUADS[f] };
    for (let c = 0; c < 9; c++) {
      if (hide.has(f * 9 + c)) continue;
      const s = ids[f * 9 + c];
      face.ids[c] = s;
      face.rot[c] = c === 4 ? turns[f] & 3 : EXPECT_ROT[s * 54 + f * 9 + c];
    }
    out.push(face);
  }
  return { t, faces: out };
}

// 手順を回しながらフレームを作る: 1 手 100ms、手と手の間に still 枚（16ms おき）
function film(start: CubeState, moves: number[], still: number, hide: (i: number) => Set<number> = () => new Set(), faces?: number[]): SightFrame[] {
  const frames: SightFrame[] = [];
  let state = start;
  const turns = [0, 0, 0, 0, 0, 0];
  let t = 0;
  let n = 0;
  const hold = () => {
    for (let i = 0; i < still; i++, t += 16) frames.push(frame(t, state, turns, hide(n++), faces));
  };
  hold();
  for (const m of moves) {
    state = applyMove(state, m);
    turns[Math.floor(m / 3)] += (m % 3) + 1;
    t += 100;
    hold();
  }
  return frames;
}

function scramble(seed: number, n: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  while (out.length < n) {
    const m = Math.floor(r() * NUM_MOVES);
    if (out.length && Math.floor(out[out.length - 1] / 3) === Math.floor(m / 3)) continue;
    out.push(m);
  }
  return out;
}

describe("ピースの時刻表で解く", () => {
  it("手と手の間が見えていれば、手順がそのまま出る", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const sc = scramble(seed, 20);
      const start = sc.reduce((s, m) => applyMove(s, m), solvedState());
      const solve = [...sc].reverse().map(inverseMove);
      const r = decodePieces(buildTable(film(start, solve, 4)), start, solvedState());
      expect(r.reachedEnd).toBe(true);
      expect(r.moves.map((m) => m.move)).toEqual(solve);
    }
  });
  it("間の状態が見えない速い連続（5 手ぶん読めない）も、前後からつなぐ", () => {
    const sc = scramble(11, 18);
    const start = sc.reduce((s, m) => applyMove(s, m), solvedState());
    const solve = [...sc].reverse().map(inverseMove);
    const frames = film(start, solve, 4);
    // 7〜11 手目の後のフレームを落とす（その間の状態は 1 枚も見えない）
    const kept = frames.filter((_, i) => Math.floor(i / 4) < 7 || Math.floor(i / 4) > 11);
    const r = decodePieces(buildTable(kept), start, solvedState());
    expect(r.reachedEnd).toBe(true);
    expect(canonical(r.moves.map((m) => m.move))).toEqual(canonical(solve));
  });
  it("指で隠れたマス・1 枚だけの読み違いがあっても解ける", () => {
    const sc = scramble(21, 20);
    const start = sc.reduce((s, m) => applyMove(s, m), solvedState());
    const solve = [...sc].reverse().map(inverseMove);
    const r0 = rng(5);
    const frames = film(start, solve, 4, () => new Set(Array.from({ length: 6 }, () => Math.floor(r0() * 27) + (r0() < 0.5 ? 0 : 9))));
    // 20 枚に 1 枚、正面の 2 マスを入れ替えて読み違える
    frames.forEach((fr, i) => {
      if (i % 20 !== 7) return;
      const f = fr.faces[0];
      [f.ids[0], f.ids[8]] = [f.ids[8], f.ids[0]];
    });
    const r = decodePieces(buildTable(frames), start, solvedState());
    expect(r.reachedEnd).toBe(true);
    expect(canonical(r.moves.map((m) => m.move))).toEqual(canonical(solve));
  });
  it("格子の向き・スロットの割り当てが狂ったフレームがあっても、面の接し方から位置を決める", () => {
    const sc = scramble(31, 16);
    const start = sc.reduce((s, m) => applyMove(s, m), solvedState());
    const solve = [...sc].reverse().map(inverseMove);
    const frames = film(start, solve, 4);
    // 3 枚に 1 枚、上の面の格子を 90° 回して読んだことにし（マスの並びとマーカーの向きが一緒に回る）、スロットも入れ替える
    frames.forEach((fr, i) => {
      if (i % 3 !== 1) return;
      const f = fr.faces[1];
      const ids = [...f.ids];
      const rot = [...f.rot];
      for (let c = 0; c < 9; c++) {
        const to = (c % 3) * 3 + (2 - Math.floor(c / 3)); // 時計回りに 90°
        f.ids[to] = ids[c];
        f.rot[to] = rot[c] < 0 ? -1 : (rot[c] + 1) & 3;
      }
      f.quad = [...f.quad.slice(6), ...f.quad.slice(0, 6)]; // 外枠の「左上」も 1 つずれる
      f.slot = 4;
    });
    const r = decodePieces(buildTable(frames), start, solvedState());
    expect(r.reachedEnd).toBe(true);
    expect(r.moves.map((m) => m.move)).toEqual(solve);
  });
});
