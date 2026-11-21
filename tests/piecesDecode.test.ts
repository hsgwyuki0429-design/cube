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

// ---- 表の AND 版（src/track/pieces/tables.ts・solve.ts） ----
import { solvePieces } from "../src/track/pieces/solve";
import { type Eq, meetSeqs, seqTable, sequencesBetweenStates, solveExact } from "../src/track/pieces/tables";
import { PERM } from "../src/track/pieces/model";

// 冗長でない k 手の手順を全部（表とは別に作る: 同じ面が続かず、反対の面の 2 手は面の番号の小さい方を先に）
function allSeqs(k: number): number[][] {
  let out: number[][] = [[]];
  for (let d = 0; d < k; d++) {
    const next: number[][] = [];
    for (const s of out)
      for (let m = 0; m < 18; m++) {
        const last = s.length ? s[s.length - 1] : -1;
        if (last >= 0) {
          const a = Math.floor(last / 3);
          const b = Math.floor(m / 3);
          if (a === b || ([3, 4, 5, 0, 1, 2][b] === a && b < a)) continue;
        }
        next.push([...s, m]);
      }
    out = next;
  }
  return out;
}
const carry = (x: number, seq: number[]) => seq.reduce((p, m) => PERM[m][p], x);
const key = (q: number[][]) => q.map((s) => s.join(",")).sort();

describe("表の AND で区間の手順を解く", () => {
  const f = (name: string) => "URFDLB".indexOf(name[0]) * 9 + Number(name[1]);
  it("R U: F2→U8 と U8→R0 は同じピースの同じ式、R1→R5 の式を足すと 1 通りに決まる", () => {
    // 揃った状態から R U。ステッカー a がマス b に見えた → ピースの代表の位置の式（区間の始め: 揃った状態の代表の位置）
    const seq = parseMoves("R U");
    const st = end(solvedState(), seq);
    const ids = stickerIds(st);
    const eqOf = (sticker: number): Eq => {
      const at = ids.indexOf(sticker); // そのステッカーが見えたマス
      return { from: REF_AT[sticker * 54 + sticker], to: REF_AT[sticker * 54 + at], w: 12 };
    };
    // F2 と U8 と R0 は同じコーナー: どのステッカーが見えても同じ式
    expect(eqOf(f("F2"))).toEqual(eqOf(f("U8")));
    expect(eqOf(f("U8"))).toEqual(eqOf(f("R0")));
    const one = solveExact(2, [eqOf(f("F2"))], []);
    expect(one.length).toBeGreaterThan(1); // 1 本だけでは決まらない
    expect(key(one)).toContain(seq.join(","));
    // R の面のエッジ（R1→R5）の式を足すと 2 手の手順は R U と F R の 2 通りまで減る（F R でもコーナーは同じ向きで
    // UFR に戻り、UR のエッジは BR に行く）。U のセンターを 1 回回した式（センターが見えていれば読める）で R U に決まる
    const two = solveExact(2, [eqOf(f("F2")), eqOf(f("R1"))], []);
    expect(key(two)).toEqual(key([seq, parseMoves("F R")]));
    expect(two.length).toBeLessThan(one.length);
    expect(solveExact(2, [eqOf(f("F2")), eqOf(f("R1"))], [{ f: 0, d: 1, w: 12 }])).toEqual([seq]);
    // 0・1 手の手順では満たせない（最小の手の数は 2）
    expect(solveExact(0, [eqOf(f("F2")), eqOf(f("R1"))], [])).toEqual([]);
    expect(solveExact(1, [eqOf(f("F2")), eqOf(f("R1"))], [])).toEqual([]);
  });
  it("表の AND の結果が、全部の手順を試した結果と同じ（k ≤ 3 で網羅的に）・突き合わせ（k = 5）も", () => {
    const r = rng(7);
    for (let k = 0; k <= 3; k++) expect(seqTable(k).n).toBe(allSeqs(k).length);
    for (let trial = 0; trial < 24; trial++) {
      const k = trial % 4;
      // 適当な状態と、適当な手順の行き先から、ピース 1〜4 個の式
      const start = piecesOf(end(solvedState(), scramble(100 + trial, 12)));
      const truth = scramble(200 + trial, k);
      const npieces = 1 + Math.floor(r() * 4);
      const pieces = Array.from({ length: npieces }, () => Math.floor(r() * 20));
      const eqs: Eq[] = pieces.map((p) => ({ from: start[p], to: carry(start[p], truth), w: 1 }));
      const brute = allSeqs(k).filter((s) => eqs.every((e) => carry(e.from, s) === e.to));
      expect(key(solveExact(k, eqs, []))).toEqual(key(brute));
    }
    // 5 手: 前 3 手 + 後ろ 2 手の突き合わせ
    const start = piecesOf(end(solvedState(), scramble(300, 12)));
    const truth = parseMoves("R U F' L2 D");
    const eqs: Eq[] = [0, 3, 8, 12, 15, 19].map((p) => ({ from: start[p], to: carry(start[p], truth), w: 1 }));
    const brute = allSeqs(5).filter((s) => eqs.every((e) => carry(e.from, s) === e.to));
    expect(key(meetSeqs(5, eqs, []))).toEqual(key(brute));
    // 状態から状態へ: R U F の 3 手（ピース 20 個の式）は 1 通り
    const A = piecesOf(solvedState());
    const B = piecesOf(end(solvedState(), parseMoves("R U F")));
    expect(sequencesBetweenStates(A, B, 3)).toEqual([parseMoves("R U F")]);
  });
  it("センターの向きの式（面を回した量の合計 ≡ δ mod 4）で候補が減る", () => {
    // U の面のピースが動かない式だけ（D の面を回す手順なら何でも合う）
    const start = piecesOf(solvedState());
    const eqs: Eq[] = [0, 1, 2, 3].map((p) => ({ from: start[p], to: start[p], w: 1 }));
    const without = solveExact(2, eqs, []);
    const withC = solveExact(2, eqs, [{ f: 3, d: 2, w: 1 }]); // D を合わせて 2 回（D2 か、D と D の間に何か）
    expect(withC.length).toBeLessThan(without.length);
    expect(withC.length).toBeGreaterThan(0);
    for (const s of withC) expect(s.filter((m) => Math.floor(m / 3) === 3).reduce((a, m) => a + (m % 3) + 1, 0) % 4).toBe(2);
  });
});

describe("表の AND 版で解く（合成の読み）", () => {
  it("手と手の間が見えていれば、手順がそのまま出る（推定なし）", () => {
    for (let seed = 1; seed <= 4; seed++) {
      const sc = scramble(seed, 20);
      const start = end(solvedState(), sc);
      const solve = [...sc].reverse().map(inverseMove);
      const r = solvePieces(buildTable(film(start, solve, 4)), start, solvedState());
      expect(r.reachedEnd).toBe(true);
      expect(r.moves.map((m) => m.move)).toEqual(solve);
      expect(r.moves.filter((m) => m.inferred).length).toBe(0);
    }
  });
  it("1 フレームだけステッカーを 1 枚読み違えても正しい手順になる", () => {
    for (let seed = 51; seed <= 55; seed++) {
      const moves = scramble(seed, 10);
      const frames = film(solvedState(), moves, 4);
      const fr = frames[Math.floor(frames.length / 2)];
      const face = fr.faces[0];
      const wrong = (face.ids[0] + 9 * 2) % 54;
      face.ids[0] = wrong;
      face.rot[0] = EXPECT_ROT[wrong * 54 + 2 * 9 + 0];
      const r = solvePieces(buildTable(frames), solvedState(), end(solvedState(), moves));
      expect(r.reachedEnd).toBe(true);
      expect(canonical(r.moves.map((m) => m.move))).toEqual(canonical(moves));
      expect(r.moves.filter((m) => m.inferred).length).toBe(0);
    }
  });
  it("確かな読みが続けて読み違っても（2 フレーム・同じ所）、式を外して正しい手順になる", () => {
    const moves = scramble(81, 10);
    const frames = film(solvedState(), moves, 6);
    const i = Math.floor(frames.length / 2);
    for (const fr of [frames[i], frames[i + 1]]) {
      const face = fr.faces[0];
      const wrong = (face.ids[2] + 9 * 2) % 54;
      face.ids[2] = wrong;
      face.rot[2] = EXPECT_ROT[wrong * 54 + 2 * 9 + 2];
    }
    const r = solvePieces(buildTable(frames), solvedState(), end(solvedState(), moves));
    expect(r.reachedEnd).toBe(true);
    expect(canonical(r.moves.map((m) => m.move))).toEqual(canonical(moves));
    // 外した式の区間は inferred の候補: 確かめで 1 つに決まれば確定（確定のまま間違えた手はない）
    const got = canonical(r.moves.filter((m) => !m.inferred).map((m) => m.move));
    for (const m of got) expect(canonical(moves)).toContain(m);
  });
  it("1 フレームだけ面のスロットを入れ替えても正しい手順になる", () => {
    const moves = scramble(61, 12);
    const frames = film(solvedState(), moves, 4);
    for (const i of [7, 23, 31]) {
      const fr = frames[i];
      [fr.faces[1].slot, fr.faces[2].slot] = [fr.faces[2].slot, fr.faces[1].slot];
    }
    const r = solvePieces(buildTable(frames), solvedState(), end(solvedState(), moves));
    expect(r.reachedEnd).toBe(true);
    expect(r.moves.map((m) => m.move)).toEqual(moves);
  });
  it("回った層が見えない区間の手は inferred になる（U2 R2 L2 U2 と D2 R2 L2 D2 は同じ状態）", () => {
    const before = parseMoves("R U F' D2 L F");
    const hidden = parseMoves("U2 R2 L2 U2");
    const after = parseMoves("B' U' L D2 F' R");
    const moves = [...before, ...hidden, ...after];
    const frames = film(solvedState(), moves, 4, { skip: (i) => i >= before.length && i < before.length + hidden.length - 1 });
    const r = solvePieces(buildTable(frames), solvedState(), end(solvedState(), moves));
    expect(r.reachedEnd).toBe(true);
    expect(r.moves.slice(0, before.length).map((m) => m.move)).toEqual(before);
    expect(r.moves.slice(0, before.length).every((m) => !m.inferred)).toBe(true);
    expect(r.moves.slice(-after.length).map((m) => m.move)).toEqual(after);
    expect(r.moves.slice(-after.length).every((m) => !m.inferred)).toBe(true);
    // 隠れた区間の手は inferred（どちらの並びかは決まらない）
    const mid = r.moves.slice(before.length, r.moves.length - after.length);
    expect(mid.length).toBe(4);
    expect(mid.every((m) => m.inferred)).toBe(true);
  });
});

describe("進み具合の知らせ（本体の見張り STALL_MS: 解き直しの間も 1 秒より短い間隔で知らせる）", () => {
  it("表の AND 版も最初の版も、解き直し・答えの確かめの間に tick を呼び続ける", () => {
    const sc = scramble(9, 25);
    const start = end(solvedState(), sc);
    const solve = [...sc].reverse().map(inverseMove);
    const frames = film(start, solve, 4, { skip: (i) => i % 5 === 3 });
    for (const run of [
      (tick: () => void) => solvePieces(buildTable(frames), start, solvedState(), { tick }),
      (tick: () => void) => decodePieces(buildTable(frames), start, solvedState(), { tick }),
    ]) {
      const at: number[] = [performance.now()];
      const r = run(() => at.push(performance.now()));
      at.push(performance.now());
      expect(r.reachedEnd).toBe(true);
      expect(at.length).toBeGreaterThan(10);
      let gap = 0;
      for (let i = 1; i < at.length; i++) gap = Math.max(gap, at[i] - at[i - 1]);
      expect(gap).toBeLessThan(1000);
    }
  });
});
