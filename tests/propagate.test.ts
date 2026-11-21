// 伝搬版（src/track/pieces/propagate.ts）: 区間の動きを行き先の表で持ち、区間をまたいで絞る。
//   - 区間の g を掛け合わせた行き先が、手順の組を全部試した結果と同じ（短い手順で網羅的に）
//   - 1 つ目と 3 つ目の見え方にだけ見えたピースの式で、間の区間の候補が減る（後ろの情報で前が決まる）
//   - 仮説の数の上限で切っていた場面（読みの少ない区間の後で、どの仮説も同じコスト）で、見込みが正しい手順を残す
import { describe, expect, it } from "vitest";
import { MOVE_NAMES, applyMoves, parseMoves, solvedState } from "../src/cube/model";
import { type SGroup, type Sight, applySeq, withCenters } from "../src/track/pieces/decode";
import { NUM_PIECES, PERM, piecesOf } from "../src/track/pieces/model";
import { composeMoves, movesOf, popcount, propagate, setOfSequences } from "../src/track/pieces/propagate";
import { solveSights, strongOf } from "../src/track/pieces/solve";
import { bitsOf } from "../src/track/pieces/table";
import { CLS, IDX, canFollow, seqTable } from "../src/track/pieces/tables";

// 冗長でない k 手までの手順を全部
function allSeqs(maxK: number): number[][] {
  const out: number[][] = [[]];
  let cur: number[][] = [[]];
  for (let d = 0; d < maxK; d++) {
    const next: number[][] = [];
    for (const s of cur) for (let m = 0; m < 18; m++) if (canFollow(s.length ? s[s.length - 1] : -1, m)) next.push([...s, m]);
    out.push(...next);
    cur = next;
  }
  return out;
}

// 置き方の決まった面の確かな読み（ピース p が facelet at に見えた）だけの見え方
function sightOf(t0: number, t1: number, reads: { p: number; at: number }[], w = 11.8): Sight {
  const g: SGroup = {
    n: reads.length,
    np: reads.length,
    nc: 1,
    robust: true,
    sure: true,
    mult: 1,
    P: Uint8Array.from(reads, (r) => r.p),
    A: Uint8Array.from(reads, (r) => r.at),
    prior: new Float32Array(1),
    W: new Float32Array(reads.length).fill(w),
    R: new Float32Array(reads.length).fill(w),
  };
  return { learn: new Int8Array(6).fill(-1), t0, t1, frame0: 0, frame1: 0, groups: reads.length ? [g] : [], readings: reads.length, weight: w * reads.length };
}
// 状態 s（ピースの位置）のピース ps の読み
const readsOf = (s: Uint8Array, ps: number[]) => ps.map((p) => ({ p, at: s[p] }));
// 手 m で動くピース
const movedBy = (s: Uint8Array, ms: number[]) => Array.from({ length: NUM_PIECES }, (_, p) => p).filter((p) => ms.some((m) => PERM[m][s[p]] !== s[p]));

describe("区間の動きの掛け合わせ（composeMoves）", () => {
  it("2 つの区間の行き先の表を掛け合わせたものが、手順の組を全部試した結果と同じ", () => {
    const pool = allSeqs(2);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let trial = 0; trial < 12; trial++) {
      // 区間ごとに手順をいくつか選ぶ（2 手まで）
      const pick = () => pool.filter(() => rnd() < 0.08);
      const s1 = pick();
      const s2 = pick();
      if (!s1.length || !s2.length) continue;
      const m = composeMoves(movesOf(setOfSequences(2, s1)), movesOf(setOfSequences(2, s2)));
      // 全部の組を試す: 種類 c の位置 x のピースが行ける位置、面 f の回した量
      const pos = new Uint32Array(48);
      const amt = new Uint8Array(6);
      for (const a of s1)
        for (const b of s2) {
          const q = [...a, ...b];
          for (let f = 0; f < 54; f++) {
            if (CLS[f] < 0) continue;
            let y = f;
            for (const mv of q) y = PERM[mv][y];
            pos[CLS[f] * 24 + IDX[f]] |= 1 << IDX[y];
          }
          for (let f = 0; f < 6; f++) amt[f] |= 1 << (q.filter((mv) => ((mv / 3) | 0) === f).reduce((x, mv) => x + (mv % 3) + 1, 0) & 3);
        }
      expect(Array.from(m.pos)).toEqual(Array.from(pos));
      expect(Array.from(m.amt)).toEqual(Array.from(amt));
    }
  });
});

describe("区間をまたぐ式（propagate）", () => {
  // 始まり → 見え方 0（全部読める）→ R → 見え方 1（R でも U でも動かないピースだけ）→ U → 見え方 2（動かないピースと、R・U で動いたピース）。
  // 見え方 0 と 2 にだけ見えたピース（R・U で動いたもの）の式 U(R(x)) = y で、見え方 0〜1 の区間（R）の候補が減る
  const start = withCenters(piecesOf(solvedState()));
  const R = parseMoves("R")[0];
  const U = parseMoves("U")[0];
  const s1 = applySeq(start, [R]);
  const s2 = applySeq(s1, [U]);
  const all = Array.from({ length: NUM_PIECES }, (_, p) => p);
  const still = all.filter((p) => !movedBy(start, [R]).includes(p) && !movedBy(s1, [U]).includes(p));
  const moved = all.filter((p) => !still.includes(p));
  const sights = [sightOf(0, 50, readsOf(start, all)), sightOf(150, 200, readsOf(s1, still)), sightOf(300, 350, readsOf(s2, [...still, ...moved]))];
  const strong = sights.map((sg) => strongOf(sg, bitsOf(0.02)));
  it("後ろの見え方の読みで、前の区間の候補が減り、本当の手は残る", () => {
    expect(still.length).toBeGreaterThan(4);
    const p = propagate(sights, strong, start, s2);
    const set = p.sets[1]; // 見え方 0 → 1
    expect(set.bits).not.toBeNull();
    expect(set.local).toBeGreaterThan(1);
    expect(set.count).toBeLessThan(set.local);
    expect(p.stats.crossNarrowed).toBeGreaterThan(0);
    // 本当の手（R）は残る
    const i = seqTable(1).moves.findIndex((m) => m === R);
    expect(set.bits![1][i >>> 5] & (1 << (i & 31))).not.toBe(0);
    // 残った候補はどれも、R の後に U と組み合わせて見え方 2 の読みを全部満たせる（見え方 1 の読みも）
    const survivors: number[][] = [];
    for (let k = 0; k <= set.K; k++) {
      const tb = seqTable(k);
      for (let j = 0; j < tb.n; j++) if (set.bits![k][j >>> 5] & (1 << (j & 31))) survivors.push(Array.from(tb.moves.subarray(j * k, (j + 1) * k)));
    }
    expect(survivors.length).toBe(popcount(set.bits!.reduce((a, b) => Uint32Array.from([...a, ...b]), new Uint32Array(0))));
  });
  it("前の区間の候補を絞らない（区間の式だけ）と、見え方 0 と 2 の式では決まらない手が残る", () => {
    const p = propagate(sights, strong, start, s2, { rounds: 1, pruneBits: 1e9 });
    expect(p.sets[1].count).toBe(p.sets[1].local);
  });
});

describe("仮説の数の上限で切っていた場面（伝搬版の見込み）", () => {
  // 見え方 1 は 1 ピースしか読めず（R U で動いた UFR のコーナー）、それに合う 2 手の手順がいくつもある（どれも同じコスト: 区間の解が複数）。
  // すぐ後の見え方 2 は全部のピースが読める。仮説の数の上限が小さいと、コストだけで並べた前向きの仮説は本当の状態を落とす
  // （実物では IMG_5048 の 5Mbps の 34.9〜36.4 秒: 上限 128 で本当の手順を落とした）。伝搬版は見え方 2 の読みからの見込みで並べるので残す
  const start = solvedState();
  const truth = parseMoves("R U");
  const s0 = withCenters(piecesOf(start));
  const s1 = applySeq(s0, truth);
  const all = Array.from({ length: NUM_PIECES }, (_, p) => p);
  const ufr = all.find((p) => movedBy(s0, [truth[0]]).includes(p) && movedBy(applySeq(s0, [truth[0]]), [truth[1]]).includes(p))!;
  const sights = [sightOf(0, 50, readsOf(s0, all)), sightOf(400, 420, readsOf(s1, [ufr])), sightOf(440, 480, readsOf(s1, all))];
  const end = applyMoves(start, truth);
  const same = (a: Uint8Array, b: Uint8Array) => a.slice(0, NUM_PIECES).every((v, i) => v === b[i]);
  const kept = (propagateOn: boolean, cap: number) => {
    let at1: Uint8Array[] = [];
    let multi = 0;
    const r = solveSights(sights, start, end, {
      propagate: propagateOn,
      capHyps: cap,
      propCap: cap,
      onHyps: (back, step, hyps) => {
        if (!back && step === 1) at1 = hyps.map((h) => h.s);
      },
      onInterval: (x) => {
        if (!x.back && x.step === 1) multi = Math.max(multi, x.sols.length);
      },
    });
    return { truthKept: at1.some((x) => same(x, s1)), hyps: at1.length, multi, r };
  };
  it("上限 1 でも、伝搬版は見え方 1 の仮説に本当の状態を残す", () => {
    const p = kept(true, 1);
    expect(p.multi).toBeGreaterThan(1); // 見え方 1 の区間の解は 2 つ以上（上限より多い）
    expect(p.hyps).toBeLessThanOrEqual(1);
    expect(p.truthKept).toBe(true);
    expect(p.r.reachedEnd).toBe(true);
    expect(p.r.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe("R U");
  });
  it("（比べる）見込みなしで上限 1 だと、見え方 1 の仮説はコストだけで選ばれ、本当の状態を落とす（後ろ向きとつないで答えは戻る）", () => {
    const q = kept(false, 1);
    expect(q.hyps).toBeLessThanOrEqual(1);
    expect(q.truthKept).toBe(false);
  });
});
