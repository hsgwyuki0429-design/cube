// ステッカーの動きの方程式（src/track/pieces）: 合成した読み（正面・上・右の 3 面が見えるキューブ）から手順を解く
import { describe, expect, it } from "vitest";
import { type CubeState, NUM_MOVES, applyMove, inverseMove, parseMoves, solvedState } from "../src/cube/model";
import { stickerIds } from "../src/cube/stickers";
import { canonical, decodePieces } from "../src/track/pieces/decode";
import { EXPECT_ROT, PIECE_OF, REF_AT, piecesOf } from "../src/track/pieces/model";
import { buildTable } from "../src/track/pieces/table";
import type { SightFace, SightFrame } from "../src/track/sight";

// 面（キューブの面 = カメラの面: 姿勢 0）の外枠。上の面は正面の上、右の面は正面の右に開いた形
const QUADS: Record<number, number[]> = { 0: [100, 0, 200, 0, 200, 100, 100, 100], 2: [100, 100, 200, 100, 200, 200, 100, 200], 1: [200, 100, 300, 100, 300, 200, 200, 200] };

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// 状態から 1 フレームの読みを作る。hide: 隠すマス（面 * 9 + マス）。turns: 面ごとに回した回数（センターのマーカーの向き）
function frame(t: number, state: CubeState, hide = new Set<number>(), faces = [2, 0, 1], turns = [0, 0, 0, 0, 0, 0]): SightFrame {
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

// 手順を回しながらフレームを作る: 1 手 100ms、手と手の間に still 枚（16ms おき）。skip(i): 手 i の後のフレームを作らない
function film(start: CubeState, moves: number[], still: number, opts: { hide?: (n: number) => Set<number>; skip?: (i: number) => boolean; faces?: number[] } = {}): SightFrame[] {
  const frames: SightFrame[] = [];
  let state = start;
  let t = 0;
  let n = 0;
  const turns = [0, 0, 0, 0, 0, 0];
  const hold = (i: number) => {
    for (let k = 0; k < still; k++, t += 16) if (!opts.skip?.(i)) frames.push(frame(t, state, opts.hide?.(n++), opts.faces, turns));
  };
  hold(-1);
  moves.forEach((m, i) => {
    state = applyMove(state, m);
    turns[Math.floor(m / 3)] += (m % 3) + 1;
    t += 100;
    hold(i);
  });
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

const end = (start: CubeState, moves: number[]) => moves.reduce((s, m) => applyMove(s, m), start);

describe("ステッカーの式", () => {
  const f = (name: string) => "URFDLB".indexOf(name[0]) * 9 + Number(name[1]);
  it("同じピースのステッカーは同じ式になる（F2 が U8 に見えた ⇔ U8 が R0 に見えた）", () => {
    expect(PIECE_OF[f("F2")]).toBe(PIECE_OF[f("U8")]);
    expect(REF_AT[f("F2") * 54 + f("U8")]).toBe(REF_AT[f("U8") * 54 + f("R0")]);
    expect(REF_AT[f("F2") * 54 + f("U8")]).toBe(REF_AT[f("R0") * 54 + f("F2")]);
  });
  it("R U を回すと、読みの式を重ねて 1 通りに決まる", () => {
    // R の後: R1 が R5 に見える（R の面のエッジが時計回りに 1 つ動いた）
    const afterR = applyMove(solvedState(), parseMoves("R")[0]);
    const ids = stickerIds(afterR);
    expect(ids[f("R5")]).toBe(f("R1"));
    expect(REF_AT[f("R1") * 54 + f("R5")]).toBe(piecesOf(afterR)[PIECE_OF[f("R1")]]);
    const moves = parseMoves("R U");
    const r = decodePieces(buildTable(film(solvedState(), moves, 4)), solvedState(), end(solvedState(), moves));
    expect(r.reachedEnd).toBe(true);
    expect(r.moves.map((m) => m.move)).toEqual(moves);
    expect(r.moves.filter((m) => m.inferred)).toEqual([]);
  });
});

describe("ステッカーの動きの方程式で解く", () => {
  it("手と手の間が見えていれば、手順がそのまま出る（推定なし）", () => {
    for (let seed = 1; seed <= 4; seed++) {
      const sc = scramble(seed, 20);
      const start = end(solvedState(), sc);
      const solve = [...sc].reverse().map(inverseMove);
      const r = decodePieces(buildTable(film(start, solve, 4)), start, solvedState());
      expect(r.reachedEnd).toBe(true);
      expect(r.moves.map((m) => m.move)).toEqual(solve);
      expect(r.moves.filter((m) => m.inferred).length).toBe(0);
    }
  });
  it("合成の 10 手で、1 フレームだけステッカーを 1 枚読み違えても正しい手順になる", () => {
    for (let seed = 51; seed <= 55; seed++) {
      const moves = scramble(seed, 10);
      const frames = film(solvedState(), moves, 4);
      // 真ん中あたりの 1 フレーム: 正面の左上のマスを、別のピースのステッカーに読み違える
      const fr = frames[Math.floor(frames.length / 2)];
      const face = fr.faces[0];
      const wrong = (face.ids[0] + 9 * 2) % 54; // 同じ並びの、別の面のステッカー（コーナー）
      face.ids[0] = wrong;
      face.rot[0] = EXPECT_ROT[wrong * 54 + 2 * 9 + 0];
      const r = decodePieces(buildTable(frames), solvedState(), end(solvedState(), moves));
      expect(r.reachedEnd).toBe(true);
      expect(canonical(r.moves.map((m) => m.move))).toEqual(canonical(moves));
      expect(r.moves.filter((m) => m.inferred).length).toBe(0);
    }
  });
  it("1 フレームだけ面のスロットを入れ替えても（中身と外枠はそのまま）正しい手順になる", () => {
    const moves = scramble(61, 12);
    const frames = film(solvedState(), moves, 4);
    for (const i of [7, 23, 31]) {
      const fr = frames[i];
      [fr.faces[1].slot, fr.faces[2].slot] = [fr.faces[2].slot, fr.faces[1].slot];
    }
    const r = decodePieces(buildTable(frames), solvedState(), end(solvedState(), moves));
    expect(r.reachedEnd).toBe(true);
    expect(r.moves.map((m) => m.move)).toEqual(moves);
    expect(r.moves.filter((m) => m.inferred).length).toBe(0);
  });
  it("格子の向きだけが 90° 狂ったフレームがあっても、面の接し方から位置を決める", () => {
    const moves = scramble(31, 16);
    const frames = film(solvedState(), moves, 4);
    // 3 枚に 1 枚、上の面の格子を 90° 回して読んだことにする（マスの並びとマーカーの向きと外枠の「左上」が一緒に回る）
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
      f.quad = [...f.quad.slice(6), ...f.quad.slice(0, 6)];
      f.slot = 4;
    });
    const r = decodePieces(buildTable(frames), solvedState(), end(solvedState(), moves));
    expect(r.reachedEnd).toBe(true);
    expect(r.moves.map((m) => m.move)).toEqual(moves);
  });
  it("指で隠れたマスがあっても解ける", () => {
    const sc = scramble(21, 20);
    const start = end(solvedState(), sc);
    const solve = [...sc].reverse().map(inverseMove);
    const r0 = rng(5);
    const frames = film(start, solve, 4, { hide: () => new Set(Array.from({ length: 6 }, () => Math.floor(r0() * 27) + (r0() < 0.5 ? 0 : 9))) });
    const r = decodePieces(buildTable(frames), start, solvedState());
    expect(r.reachedEnd).toBe(true);
    expect(canonical(r.moves.map((m) => m.move))).toEqual(canonical(solve));
  });
  it("回った層が見えない区間の手は inferred になる（U2 R2 L2 U2 と D2 R2 L2 D2 は同じ状態）", () => {
    // 隠れた手の前後の手は U・D・R・L 以外（まとめると隠れた手とくっつく）
    const before = parseMoves("R U F' D2 L F");
    const hidden = parseMoves("U2 R2 L2 U2");
    const after = parseMoves("B' U' L D2 F' R");
    const moves = [...before, ...hidden, ...after];
    // 隠れた 4 手の間はフレームがない
    const frames = film(solvedState(), moves, 4, { skip: (i) => i >= before.length && i < before.length + hidden.length - 1 });
    const r = decodePieces(buildTable(frames), solvedState(), end(solvedState(), moves));
    expect(r.reachedEnd).toBe(true);
    expect(r.moves.length).toBe(moves.length);
    // 前後の手は確定で正しい
    expect(r.moves.slice(0, before.length).map((m) => m.move)).toEqual(before);
    expect(r.moves.slice(0, before.length).every((m) => !m.inferred)).toBe(true);
    expect(r.moves.slice(before.length + 4).map((m) => m.move)).toEqual(after);
    expect(r.moves.slice(before.length + 4).every((m) => !m.inferred)).toBe(true);
    // 隠れた区間の 4 手は inferred（どちらの並びかは決まらない）
    expect(r.moves.slice(before.length, before.length + 4).every((m) => m.inferred)).toBe(true);
  });
});
