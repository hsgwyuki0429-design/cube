// 区間の手順を「連立方程式を表の AND で解く」ための表（solve.ts・verify）。
//
// 区間の始めに位置 x にいたピースは、区間の手順 σ で位置 y = σ(x) に行く。ピースの移り方はほかのピースや状態によらず、手順だけで決まる。
// そこで、冗長でない（同じ面が続かず、反対の面の 2 手は面の番号の小さい方を先にした）k 手の手順を全部並べて番号を付け、
// T[k][x][y] = 「x を y に運ぶ k 手の手順の集合」をビットの列で持つ（コーナーの位置 24・エッジの位置 24 ごと）。
// 読めたピースがどれも式 x → y を満たす手順の集合 = それらの T[k][x][y] の AND。センターの向きの式「面 f を回した量の合計 ≡ δ（mod 4）」も
// 同じ形の表 C[k][f][δ] で AND する。k は 0〜4 を表で、5〜8 手は前から ⌈k/2⌉ 手・後ろから ⌊k/2⌋ 手の表を引いて真ん中で突き合わせる。
// 手順の数（k = 0〜4）: 1・18・243・3240・43239。表の大きさは k = 4 がコーナーとエッジで 576 × 2 本 × 1352 語 = 6.2MB（初めて使うときに作る）。
// DOM もカメラも知らない
import { OPPOSITE } from "../../cube/model";
import { PARTNERS } from "../../cube/stickers";
import { PERM } from "./model";

export const MAX_TABLE_K = 4;
export const MAX_MEET_K = 8;

// facelet → 種類（0 = コーナー・1 = エッジ・-1 = センター）とその中の番号（0〜23）
export const CLS = new Int8Array(54).fill(-1);
export const IDX = new Int8Array(54).fill(-1);
const POS: number[][] = [[], []]; // 種類 → 番号 → facelet
for (let f = 0; f < 54; f++) {
  const n = PARTNERS[f].length;
  if (!n) continue;
  const c = n === 2 ? 0 : 1;
  CLS[f] = c;
  IDX[f] = POS[c].length;
  POS[c].push(f);
}
export const positionOf = (cls: number, i: number): number => POS[cls][i];

// 手 m のすぐ後に手 n を置いてよいか（冗長でない並びの決まり。DFS の枝・decode.ts の dfs と同じ）
export const canFollow = (m: number, n: number): boolean => {
  if (m < 0) return true;
  const a = (m / 3) | 0;
  const b = (n / 3) | 0;
  return b !== a && !(OPPOSITE[b] === a && b < a);
};

export interface SeqTable {
  k: number;
  n: number; // 手順の数
  words: number; // ビットの列の長さ（32 ビットの語）
  moves: Int8Array; // 手順 i の j 手目 = moves[i * k + j]
  img: Uint8Array; // 手順 i で、種類 c の番号 x の行き先 = img[(i * 2 + c) * 24 + x]
  inv: Uint8Array; // 逆向き: 手順 i で番号 y に来るのは inv[(i * 2 + c) * 24 + y] から
  amount: Uint8Array; // 手順 i で面 f を回した量の合計（4 で割った余り） = amount[i * 6 + f]
  first: Int8Array; // 最初の手（k = 0 は -1）
  last: Int8Array; // 最後の手
  T: Uint32Array; // T[((c * 24 + x) * 24 + y) * words + w]
  C: Uint32Array; // C[((f * 4) + δ) * words + w]
}

const tables: (SeqTable | null)[] = new Array(MAX_TABLE_K + 1).fill(null);
let buildMs = 0;

// k 手の表（初めて使うときに作る）
export function seqTable(k: number): SeqTable {
  const have = tables[k];
  if (have) return have;
  const t0 = performance.now();
  // 冗長でない k 手の手順を全部
  let seqs: number[][] = [[]];
  for (let d = 0; d < k; d++) {
    const next: number[][] = [];
    for (const s of seqs) for (let m = 0; m < 18; m++) if (canFollow(s.length ? s[s.length - 1] : -1, m)) next.push([...s, m]);
    seqs = next;
  }
  const n = seqs.length;
  const words = Math.max(1, Math.ceil(n / 32));
  const moves = new Int8Array(n * k);
  const img = new Uint8Array(n * 48);
  const inv = new Uint8Array(n * 48);
  const amount = new Uint8Array(n * 6);
  const first = new Int8Array(n).fill(-1);
  const last = new Int8Array(n).fill(-1);
  const T = new Uint32Array(2 * 24 * 24 * words);
  const C = new Uint32Array(6 * 4 * words);
  const p = new Uint8Array(54);
  seqs.forEach((s, i) => {
    for (let f = 0; f < 54; f++) p[f] = f;
    for (let j = 0; j < k; j++) {
      const m = s[j];
      moves[i * k + j] = m;
      const Q = PERM[m];
      for (let f = 0; f < 54; f++) p[f] = Q[p[f]];
      amount[i * 6 + ((m / 3) | 0)] = (amount[i * 6 + ((m / 3) | 0)] + (m % 3) + 1) & 3;
    }
    if (k) {
      first[i] = s[0];
      last[i] = s[k - 1];
    }
    for (let c = 0; c < 2; c++)
      for (let x = 0; x < 24; x++) {
        const y = IDX[p[POS[c][x]]];
        img[(i * 2 + c) * 24 + x] = y;
        inv[(i * 2 + c) * 24 + y] = x;
        T[((c * 24 + x) * 24 + y) * words + (i >>> 5)] |= 1 << (i & 31);
      }
    for (let f = 0; f < 6; f++) C[(f * 4 + amount[i * 6 + f]) * words + (i >>> 5)] |= 1 << (i & 31);
  });
  const tb: SeqTable = { k, n, words, moves, img, inv, amount, first, last, T, C };
  tables[k] = tb;
  buildMs += performance.now() - t0;
  return tb;
}

// 調査用: 表を作るのにかかった時間と大きさ
export function tableStats(): { ms: number; bytes: number; counts: number[] } {
  let bytes = 0;
  const counts: number[] = [];
  for (const t of tables) {
    if (!t) continue;
    counts[t.k] = t.n;
    bytes += t.moves.byteLength + t.img.byteLength + t.inv.byteLength + t.amount.byteLength + t.T.byteLength + t.C.byteLength;
  }
  return { ms: buildMs, bytes, counts };
}

// 式: 種類 c の位置 x のピースが y へ（facelet で渡す）。重み w（読み違いを外すとき、外す式の重さ）
export interface Eq {
  from: number; // facelet
  to: number; // facelet
  w: number;
}
// センターの式: 面 f を回した量の合計 ≡ d（mod 4）
export interface CenterEq {
  f: number;
  d: number;
  w: number;
}

// 式を全部満たす k 手の手順の集合（ビットの列）。skip: 外す式（eqs の番号。センターは eqs.length + 番号）
export function andSet(k: number, eqs: Eq[], centers: CenterEq[], skip = -1, out?: Uint32Array, skip2 = -1): Uint32Array {
  const tb = seqTable(k);
  const W = tb.words;
  const r = out && out.length >= W ? out : new Uint32Array(W);
  r.fill(0xffffffff, 0, W);
  // 余りのビットを消す
  const tail = tb.n & 31;
  if (tail) r[W - 1] = (1 << tail) - 1;
  for (let e = 0; e < eqs.length; e++) {
    if (e === skip || e === skip2) continue;
    const c = CLS[eqs[e].from];
    const o = ((c * 24 + IDX[eqs[e].from]) * 24 + IDX[eqs[e].to]) * W;
    let any = 0;
    for (let w = 0; w < W; w++) any |= r[w] &= tb.T[o + w];
    if (!any) return r;
  }
  for (let e = 0; e < centers.length; e++) {
    if (eqs.length + e === skip || eqs.length + e === skip2) continue;
    const o = (centers[e].f * 4 + centers[e].d) * W;
    let any = 0;
    for (let w = 0; w < W; w++) any |= r[w] &= tb.C[o + w];
    if (!any) return r;
  }
  return r;
}

export const isEmpty = (b: Uint32Array, words: number): boolean => {
  for (let w = 0; w < words; w++) if (b[w]) return false;
  return true;
};

export function countBits(b: Uint32Array, words: number): number {
  let n = 0;
  for (let w = 0; w < words; w++) {
    let x = b[w];
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    n += (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return n;
}

// ビットの列 → 手順（limit 個まで）
export function seqsOf(k: number, b: Uint32Array, limit = Infinity): number[][] {
  const tb = seqTable(k);
  const out: number[][] = [];
  for (let w = 0; w < tb.words && out.length < limit; w++) {
    let x = b[w];
    while (x && out.length < limit) {
      const bit = 31 - Math.clz32(x & -x);
      x &= x - 1;
      const i = w * 32 + bit;
      out.push(Array.from(tb.moves.subarray(i * k, (i + 1) * k)));
    }
  }
  return out;
}

// 突き合わせの後ろ側: 後ろの b 手の手順ごとに、式の終わりの位置の来る元（式の行き先の並びだけで決まるので、同じ見え方の仮説で使い回せる）
export interface BackTable {
  b: number;
  m: number;
  cls: Uint8Array;
  ys: Uint8Array;
  pos: Uint8Array; // 手順 i の来る元 = pos[i * m + j]
  head: Int32Array; // 鍵 → 最初の手順（-1 = なし）
  next: Int32Array;
  mask: number;
}

const keyOf = (vals: Uint8Array, off: number, m: number): number => {
  let h = 0x811c9dc5;
  for (let j = 0; j < m; j++) h = Math.imul(h ^ vals[off + j], 0x01000193);
  return (h ^ (h >>> 15)) >>> 0;
};

export function backTable(b: number, eqs: Eq[]): BackTable {
  const B = seqTable(b);
  const m = eqs.length;
  const cls = Uint8Array.from(eqs, (e) => CLS[e.to]);
  const ys = Uint8Array.from(eqs, (e) => IDX[e.to]);
  const pos = new Uint8Array(B.n * m);
  let size = 1;
  while (size < B.n * 2) size <<= 1;
  const head = new Int32Array(size).fill(-1);
  const next = new Int32Array(B.n);
  for (let i = 0; i < B.n; i++) {
    for (let j = 0; j < m; j++) pos[i * m + j] = B.inv[(i * 2 + cls[j]) * 24 + ys[j]];
    const h = keyOf(pos, i * m, m) & (size - 1);
    next[i] = head[h];
    head[h] = i;
  }
  return { b, m, cls, ys, pos, head, next, mask: size - 1 };
}

// k 手（5〜8）の手順で式を全部満たすもの: 前から a = ⌈k/2⌉ 手・後ろから b = ⌊k/2⌋ 手。前の手順で式の始めの位置がどこへ行くか、後ろの手順の
// 逆で式の終わりの位置がどこから来るかを並べ、同じになる組を突き合わせる（つなぎ目が冗長な組は除く）。limit 個まで。back: 使い回す後ろ側
export function meetSeqs(k: number, eqs: Eq[], centers: CenterEq[], limit = 4096, back?: BackTable): number[][] {
  const a = Math.ceil(k / 2);
  const b = k - a;
  const A = seqTable(a);
  const B = seqTable(b);
  const m = eqs.length;
  const bt = back && back.b === b && back.m === m ? back : backTable(b, eqs);
  const xs = Uint8Array.from(eqs, (e) => IDX[e.from]);
  const tmp = new Uint8Array(m);
  const out: number[][] = [];
  for (let i = 0; i < A.n && out.length < limit; i++) {
    for (let j = 0; j < m; j++) tmp[j] = A.img[(i * 2 + bt.cls[j]) * 24 + xs[j]];
    for (let ib = bt.head[keyOf(tmp, 0, m) & bt.mask]; ib >= 0; ib = bt.next[ib]) {
      let ok = true;
      for (let j = 0; j < m && ok; j++) if (bt.pos[ib * m + j] !== tmp[j]) ok = false;
      if (!ok || (a && b && !canFollow(A.last[i], B.first[ib]))) continue;
      for (const c of centers) if (((A.amount[i * 6 + c.f] + B.amount[ib * 6 + c.f]) & 3) !== c.d) ok = false;
      if (!ok) continue;
      out.push([...A.moves.subarray(i * a, (i + 1) * a), ...B.moves.subarray(ib * b, (ib + 1) * b)]);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// 式を全部満たす、ちょうど k 手の手順（k ≤ 4 は表の AND、5〜8 は突き合わせ）。limit 個まで
export function solveExact(k: number, eqs: Eq[], centers: CenterEq[], limit = 4096, back?: BackTable): number[][] {
  if (k <= MAX_TABLE_K) {
    const tb = seqTable(k);
    const b = andSet(k, eqs, centers);
    return isEmpty(b, tb.words) ? [] : seqsOf(k, b, limit);
  }
  return meetSeqs(k, eqs, centers, limit, back);
}

// 状態 A から状態 B へ（ピースの位置 20 個）の、maxLen 手までの冗長でない手順を全部（答えの確かめ: decode.ts の verifyPath）
export function sequencesBetweenStates(A: ArrayLike<number>, B: ArrayLike<number>, maxLen: number, limit = 4096): number[][] {
  const eqs: Eq[] = [];
  for (let p = 0; p < 20; p++) eqs.push({ from: A[p], to: B[p], w: 1 });
  const out: number[][] = [];
  for (let k = 0; k <= Math.min(maxLen, MAX_MEET_K) && out.length < limit; k++) out.push(...solveExact(k, eqs, [], limit - out.length));
  return out;
}

// 手順を逆にした（逆の手を逆の順に。反対の面の 2 手は面の番号の小さい方を先に並べ直した）手順の番号: INVERSE[k][i]
// （後ろ向きの解き直しは時間を逆にたどるので、前向きの番号で持った区間の候補を引くのに使う。propagate.ts）
const inverses: (Int32Array | null)[] = new Array(MAX_TABLE_K + 1).fill(null);
export function inverseIndex(k: number): Int32Array {
  const have = inverses[k];
  if (have) return have;
  const tb = seqTable(k);
  const code = (ms: ArrayLike<number>) => {
    let c = 0;
    for (let j = 0; j < ms.length; j++) c = c * 18 + ms[j];
    return c;
  };
  const index = new Map<number, number>();
  for (let i = 0; i < tb.n; i++) index.set(code(tb.moves.subarray(i * k, (i + 1) * k)), i);
  const out = new Int32Array(tb.n);
  const inv = (m: number) => ((m / 3) | 0) * 3 + [2, 1, 0][m % 3];
  for (let i = 0; i < tb.n; i++) {
    const r = Array.from(tb.moves.subarray(i * k, (i + 1) * k)).reverse().map(inv);
    for (let j = 0; j + 1 < r.length; j++) {
      const a = (r[j] / 3) | 0;
      const b = (r[j + 1] / 3) | 0;
      if (OPPOSITE[a] === b && a > b) [r[j], r[j + 1]] = [r[j + 1], r[j]];
    }
    const x = index.get(code(r));
    if (x === undefined) throw new Error("逆の手順が表にない");
    out[i] = x;
  }
  inverses[k] = out;
  return out;
}
