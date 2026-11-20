// ステッカーの動きの方程式で手順を解く（精密解析の解き直し。table.ts の式から）。
//
// 分からないのは手順 m1..mn。時刻 t のフレームで「ステッカー a がマス b に見えた」は「t までの手を全部合わせると a は b にいる」という
// 式 1 本で、同じピースのステッカーは同じ式なのでピース（コーナー 8・エッジ 12、各 24 通りの位置）で持つ（model.ts）。
// 式は「全部満たす」ではなく、「手の数 × moveBits + 破った式の重み」（ビット）がいちばん小さい手順を選ぶ（読み違いがあるので）:
//   - 1 手 = log2(13.35) ≈ 3.74 ビット（同じ面・反対の面の並べ替えを除いた手の並びの、1 手あたりの数）
//   - 食い違い 1 本 = log2((1 − ε)·23 / ε) ビット（table.ts。続いた読みは 1 本ぶん）
//   - 面の置き方の誤り（中身は正しいが向きや面が違う）は、ばらばらに数えず置き方を選ぶコスト 1 回（table.ts の候補の prior）
// 解き方:
//   1) フレームを時刻の鎖にする: 読みの食い違わないフレームを 1 つの「見え方」にまとめる（同じピースが違う所に見えたら次の見え方。
//      1 枚だけ見えた中間の状態も 1 つの見え方として残す）。見え方の間は 0〜数手
//   2) 見え方の間ごとに、入れられる手を絞る: ピースごとに「その位置へ合わせるのに最低何手要るか」（DIST）から、残りの手数では
//      どうしても合わない式の重みが分かるので、候補より悪くなる枝には入らない（ライブの recover.ts と同じ発想）。手を入れた子は、
//      手を入れないときより payback までしか悪くならないこと（手はその分の食い違いを減らすこと）
//   3) 始まりの状態から前向き・終わりの状態から後ろ向きに 1 歩ずつ交互に進め、同じ見え方で同じ状態になった所でつなぐ
//   4) 読めたピースが少なくて説明のつかない見え方（空白）は、上位の仮説から深い手順を前後半分ずつ突き合わせて探し、点数で候補を残す
//   5) 答えが 1 つに決まったかを確かめる（verifyPath）: 答えの状態を推測に頼らない読み（センターと面の接し方で置いた面・センターの向き）が
//      「どの 1 手を足しても食い違う」ほど決めている見え方（錨）の間ごとに、その間の手順を漏れなく探して点数を付け、近い点数の別の手順と
//      違う手を inferred にする。確かめられなかった区間（手が多すぎる・時間切れ）の手も inferred（**間違った手を「確定」にしない**）
// 状態はキューブ固定で持つ（表がキューブ固定の位置になっている）ので、仮説に姿勢がなく、持ち替えを探す枝もない。センターの向き（6 つ）は
// 状態に入れる: 1 面だけ見えているときの面の向きは、センターのマーカーの向きと仮説の回した回数で決まる（table.ts の KIND_CENTER）。
// DOM もカメラも知らない
import { type CubeState, OPPOSITE, inverseMove } from "../../cube/model";
import { DIST, NUM_PIECES, PERM, piecesOf } from "./model";
import { CENTER_SLOT, type FrameEq, type Group, type PieceTable } from "./table";

// 調査用: 時間の内訳
export const PROFILE = { dfsMs: 0, dfsNodes: 0, bridgeMs: 0, bridgeNodes: 0, bridges: 0, steps: 0, capped: 0 };

// 状態: ピース 20 個の位置と、センター 6 つの向き（4 = まだ分からない）
const SIZE = NUM_PIECES + 6;
const withCenters = (pos: Uint8Array): Uint8Array => {
  const s = new Uint8Array(SIZE).fill(4);
  s.set(pos);
  return s;
};

export interface DecodeOptions {
  moveBits: number; // 1 手のコスト（ビット）
  beam: number; // 見え方ごとに残す仮説の数
  margin: number; // いちばんよい仮説よりこれ（ビット）以上悪い候補は捨てる
  minMoves: number; // 見え方の間に入れる手の数の下限（間が短くても）
  maxMoves: number; // 上限（上位 deepHyps 個の仮説だけ）
  msPerMove: number; // 見え方の間がこれだけ開くごとに、入れてよい手を 1 つ増やす
  deepHyps: number;
  // 手を入れた仮説は、入れないときより これ（ビット）以上は悪くならないこと（手はその分の食い違いを減らすこと）
  payback: number;
  siblingBits: number; // 同じ仮説から手を入れた子どうしでは、いちばんよい子からこれ（ビット）まで残す
  splitMs: number; // フレームの間がこれより開いたら見え方を分ける
  endBits: number; // 終わりの状態と違うピース 1 個のコスト
  endMoves: number; // 最後の見え方から終わりまでに足してよい手
  keep: number; // つなぐために、見え方ごとに覚えておく仮説の数
  afterMeetMs: number; // 後ろ向きは、前向きとつながってからこれだけ進めたらやめる
  // 空白を越える探索: いちばんよい仮説でもこの見え方の食い違いが stuckBits 以上で、重みが trackBits 以上の式のピースが bridgePieces 個以上
  // あるとき、上位 bridgeHyps 個の仮説から bridgeMoves 手までを前後半分ずつ突き合わせて探す。突き合わせは追うピースが全部合うものと、
  // 1 つだけ外れたもの（読み違い 1 つ）。点数（手 + 全部の式）で上位 bridgeKeep 個を残す
  stuckBits: number;
  stuckShare: number; // かつ、その食い違いが見え方の重みの合計のこれだけの割合以上（読み違いの多い見え方で毎回探さない）
  trackBits: number;
  bridgePieces: number;
  bridgeHyps: number;
  bridgeMoves: number;
  bridgeKeep: number;
  bridgeSkips: number; // 1 つだけ外してよい追うピース（重い方から）
  // 見失った: いちばんよい仮説の食い違い（コスト − 手）が、直近 lostMs で lostBits 以上増えたら、その向きの探索をやめる
  lostMs: number;
  lostBits: number;
  nodeCap: number; // 1 つの見え方で試す候補の上限
  budgetMs: number; // 解き直しの時間の上限（前向き・後ろ向きがつながらないまま超えたらあきらめる）
  totalMs: number; // 答えの確かめも含めた時間の上限（確かめは verifyMs と、ここまでの残りの短い方。残りの区間は inferred）
  ambiguityBits: number; // 答えの確かめ: これ以内の別の解と違う手は inferred
  // 探索の途中で同じ状態に違う手順で着いたときも確かめる（答えの確かめ verifyPath があれば要らない: 時間の半分を使っていた）
  mergeAmbiguity: boolean;
  shorterBits: number; // 手の少ない別の解はこれ以内なら
  // 答えの確かめ（verifyPath）: 答えの状態を読みがはっきり支える見え方（支える重み anchorBits 以上・食い違い anchorMis 以下）の間ごとに、
  // その間の手順を漏れなく（答えより 1 手長いものまで）探して点数を付け、verifyBits 以内の別の手順と違う手を inferred にする。
  // 答えより verifyBits 以上安い手順があれば置き換える。間の手が verifyMoves より多ければ確かめられないので inferred
  verify: boolean;
  anchorBits: number;
  anchorMis: number;
  verifyBits: number;
  verifyMoves: number;
  verifyLong: number; // 間の手がこれまでなら、区間だけを解き直して確かめる（それより多ければ確かめられないので inferred）
  verifyBeam: number; // そのときの幅
  verifyNodes: number; // そのときの、1 つの見え方で試す候補の上限（超えたら漏れがありうるので確かめられない）
  verifyMs: number; // 答えの確かめに使う時間の上限（超えたら残りの区間は確かめられないので inferred）
  pinBits: number; // 錨の見え方: どの 1 手を足しても、推測に頼らない読みの食い違いがこれ（ビット）以上増えること
  deadline?: number; // この時刻（performance.now()）を過ぎたら探索をやめる（区間の解き直しで、確かめの時間の上限を守るため）
  debugVerify?: (line: string) => void; // 調査用
  onStep?: (info: { back: boolean; step: number; t: number; readings: number; depth: number; hyps: number; best: number; mis: number; expanded: number; moves: number[] }) => void; // 調査用
}

export const DEFAULT_DECODE: DecodeOptions = {
  moveBits: Math.log2(13.35),
  beam: 48,
  margin: 14,
  minMoves: 3,
  maxMoves: 4,
  msPerMove: 120,
  deepHyps: 4,
  payback: 1,
  siblingBits: 8,
  splitMs: 100,
  endBits: 40,
  endMoves: 4,
  keep: 48,
  afterMeetMs: 1500,
  stuckBits: 10,
  stuckShare: 0.3,
  trackBits: 6,
  bridgePieces: 4,
  bridgeHyps: 2,
  bridgeMoves: 8,
  bridgeKeep: 8,
  bridgeSkips: 6,
  lostMs: 1500,
  lostBits: 200,
  nodeCap: 600000,
  budgetMs: 8000,
  totalMs: 9000,
  ambiguityBits: 6,
  mergeAmbiguity: false,
  shorterBits: 12,
  verify: true,
  anchorBits: 30,
  anchorMis: 6,
  verifyBits: 8,
  verifyMoves: 7,
  verifyLong: 16,
  verifyBeam: 48,
  verifyNodes: 40000,
  verifyMs: 2000,
  pinBits: 6,
};

// 見え方の中の 1 つのまとまり（同じ並びのまとまりは重みを足して 1 つに）
interface SGroup {
  n: number;
  np: number; // ピースの読みの数（読みはピースが先、センターの向きが後）
  nc: number;
  // 置き方が推測に頼らない（センターと面の接し方で決まった面か、センターの向きを読んだ面）: 答えの確かめはこれだけで点数を付ける
  robust: boolean;
  mult?: number; // まとめた同じまとまりの数（置き方のコストもこの数だけ）
  P: Uint8Array;
  A: Uint8Array;
  prior: Float32Array;
  W: Float32Array;
  R: Float32Array; // 続いた読み全体の重み（見え方の中でいちばん大きいもの）
}

export interface Sight {
  learn: Int8Array; // 置き方の決まった面で読めたセンターの向き（面ごと。なければ -1）: 仮説がまだ向きを知らなければ、ここで決める
  t0: number;
  t1: number;
  frame0: number;
  frame1: number;
  groups: SGroup[];
  readings: number;
  weight: number; // 式の重みの合計
}

export function buildSights(table: PieceTable, options: Partial<DecodeOptions> = {}): Sight[] {
  const opt = { ...DEFAULT_DECODE, ...options };
  const out: Sight[] = [];
  const frames = table.frames;
  const pos = new Int16Array(SIZE).fill(-1);
  let learn = new Int8Array(6).fill(-1);
  let f0 = -1;
  let f1 = -1;
  let acc = new Map<string, SGroup>();
  const close = () => {
    if (f0 < 0) return;
    const groups = [...acc.values()].map(finishGroup);
    let readings = 0;
    let weight = 0;
    for (const g of groups) {
      readings += g.n;
      for (let i = 0; i < g.n; i++) weight += g.W[i];
    }
    out.push({ learn, t0: frames[f0].t, t1: frames[f1].t, frame0: f0, frame1: f1, groups, readings, weight });
    acc = new Map();
    learn = new Int8Array(6).fill(-1);
    pos.fill(-1);
    f0 = -1;
  };
  // 既定の置き方がはっきりしているまとまり（ほかの候補はコストつき）の読みで、食い違いを決める
  const solid = (g: Group) => g.prior[0] === 0 && (g.prior.length === 1 || Math.min(...g.prior.subarray(1)) > 0);
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f];
    let conflict = false;
    for (const g of fr.groups) {
      if (!solid(g)) continue;
      for (let i = 0; i < g.n && !conflict; i++) {
        const x = g.A[i];
        if (x !== 255 && pos[g.P[i]] >= 0 && pos[g.P[i]] !== x) conflict = true;
      }
    }
    if (conflict || (f0 >= 0 && fr.t - frames[f1].t > opt.splitMs)) close();
    if (f0 < 0) f0 = f;
    f1 = f;
    for (const g of fr.groups) {
      if (solid(g))
        for (let i = 0; i < g.n; i++) {
          const x = g.A[i];
          if (x !== 255) pos[g.P[i]] = x;
          if (g.mode === 0 && g.P[i] >= CENTER_SLOT && x !== 255 && learn[g.P[i] - CENTER_SLOT] < 0) learn[g.P[i] - CENTER_SLOT] = x;
        }
      const key = `${g.n}|${g.P.join(",")}|${g.A.join(",")}|${g.prior.join(",")}`;
      const o = acc.get(key);
      if (o) {
        o.mult = (o.mult ?? 1) + 1;
        for (let i = 0; i < g.n; i++) {
          o.W[i] += g.W[i];
          o.R[i] = Math.max(o.R[i], g.R[i]);
        }
      }
      else acc.set(key, { n: g.n, np: 0, nc: g.prior.length, P: g.P, A: g.A, prior: g.prior, W: Float32Array.from(g.W), R: Float32Array.from(g.R), robust: g.mode === 0 || (g.mode === 1 && g.P.some((p) => p >= CENTER_SLOT)), mult: 1 });
    }
  }
  close();
  return out;
}

// 見え方のまとまりを仕上げる: 読みをピース → センターの向きの順に並べ替え、置き方のコストを同じまとまりの数だけにする
// （同じ読みのフレームは同じ置き方を選ぶので、選んだコストも枚数ぶん）
function finishGroup(g: SGroup): SGroup {
  const idx = Array.from({ length: g.n }, (_, i) => i).sort((a, b) => (g.P[a] >= CENTER_SLOT ? 1 : 0) - (g.P[b] >= CENTER_SLOT ? 1 : 0) || a - b);
  const np = idx.filter((i) => g.P[i] < CENTER_SLOT).length;
  const A = new Uint8Array(g.nc * g.n);
  for (let c = 0; c < g.nc; c++) idx.forEach((i, j) => (A[c * g.n + j] = g.A[c * g.n + i]));
  const mult = g.mult ?? 1;
  return { ...g, np, P: Uint8Array.from(idx, (i) => g.P[i]), A, W: Float32Array.from(idx, (i) => g.W[i]), R: Float32Array.from(idx, (i) => g.R[i]), prior: mult === 1 ? g.prior : Float32Array.from(g.prior, (x) => x * mult) };
}

// 状態 s で、まとまり g の食い違い（ビット）。上限 cap を超えたら打ち切る。whole: 続いた読み全体の重みで（答えの確かめの錨）
function groupCost(g: SGroup, s: Uint8Array, cap: number, whole = false): number {
  const n = g.n;
  const Wt = whole ? g.R : g.W;
  let best = 0;
  // 状態の値 4 = センターの向きがまだ分からない（その式は食い違わない。ピースの位置が 4 になることはない）
  for (let i = 0; i < n; i++) {
    const v = s[g.P[i]];
    if (v !== g.A[i] && v !== 4) best += Wt[i];
  }
  if (best === 0) return 0;
  for (let c = 1; c < g.nc; c++) {
    let e = g.prior[c];
    if (e >= best) continue;
    const o = c * n;
    for (let i = 0; i < n && e < best; i++) {
      const v = s[g.P[i]];
      if (v !== g.A[o + i] && v !== 4) e += Wt[i];
    }
    if (e < best) best = e;
  }
  return best > cap ? best : best;
}

// あと r 手ではどうしても合わない式の重み（下限）。ピースは「そのピースを合わせるのに最低何手要るか」（DIST）、センターの向きは 1 手で合う
function groupBound(g: SGroup, s: Uint8Array, r: number): number {
  const n = g.n;
  const np = g.np;
  const P = g.P;
  const A = g.A;
  const W = g.W;
  let best = 0;
  for (let i = 0; i < np; i++) {
    const a = A[i];
    if (a === 255 || DIST[s[P[i]] * 54 + a] > r) best += W[i];
  }
  if (r === 0)
    for (let i = np; i < n; i++) {
      const v = s[P[i]];
      if (A[i] === 255 || (v !== 4 && v !== A[i])) best += W[i];
    }
  if (best === 0) return 0;
  for (let c = 1; c < g.nc; c++) {
    let e = g.prior[c];
    if (e >= best) continue;
    const o = c * n;
    for (let i = 0; i < np && e < best; i++) {
      const a = A[o + i];
      if (a === 255 || DIST[s[P[i]] * 54 + a] > r) e += W[i];
    }
    if (r === 0)
      for (let i = np; i < n && e < best; i++) {
        const v = s[P[i]];
        if (A[o + i] === 255 || (v !== 4 && v !== A[o + i])) e += W[i];
      }
    if (e < best) best = e;
  }
  return best;
}

export interface DecodedPieceMove {
  move: number;
  sight: number; // この手の後の見え方の番号（終わりに足した手は sights.length）
  t0: number; // 前の見え方が最後に見えた時刻
  t: number; // 次の見え方が最初に見えた時刻
  inferred?: boolean;
}

export interface DecodeResult {
  moves: DecodedPieceMove[];
  reachedEnd: boolean;
  method: "meet" | "forward" | "backward" | "none";
  cost: number;
  sights: number;
  expanded: number;
  ms: number;
  alternatives: number; // 確かめに使った別の解の数
  timedOut?: boolean; // 時間の上限（budgetMs）でやめた
  verified?: { replaced: number; unsure: number; unchecked: number; segments: number; ms: number; decodeMs: number }; // 答えの確かめ（verifyPath）
  meetAt?: number;
  forwardTo?: number; // 前向きが進めた最後の見え方の時刻
  backwardTo?: number;
}



interface Hyp {
  s: Uint8Array;
  cost: number;
  path: number;
}

interface Entry {
  cost: number;
  path: number;
  mis: number;
  s: Uint8Array;
}

// 手の木（前向き・後ろ向きそれぞれ 1 つ）
class Paths {
  parent = new Int32Array(4096);
  info = new Int32Array(4096);
  depth = new Int32Array(4096);
  n = 0;
  add(parent: number, move: number, step: number, guess: boolean): number {
    if (this.n === this.parent.length) {
      const grow = (x: Int32Array) => {
        const a = new Int32Array(this.n * 2);
        a.set(x);
        return a;
      };
      this.parent = grow(this.parent);
      this.info = grow(this.info);
      this.depth = grow(this.depth);
    }
    this.parent[this.n] = parent;
    this.info[this.n] = move + (guess ? 32 : 0) + step * 64;
    this.depth[this.n] = parent < 0 ? 1 : this.depth[parent] + 1;
    return this.n++;
  }
  depthOf(p: number): number {
    return p < 0 ? 0 : this.depth[p];
  }
  list(path: number): { move: number; step: number; guess: boolean }[] {
    const out: { move: number; step: number; guess: boolean }[] = [];
    for (let p = path; p >= 0; p = this.parent[p]) out.push({ move: this.info[p] & 31, step: this.info[p] >> 6, guess: (this.info[p] & 32) !== 0 });
    return out.reverse();
  }
  // 2 つの節点の共通の祖先（なければ -1）
  lca(a: number, b: number): number {
    while (this.depthOf(a) > this.depthOf(b)) a = this.parent[a];
    while (this.depthOf(b) > this.depthOf(a)) b = this.parent[b];
    while (a !== b) {
      a = this.parent[a];
      b = this.parent[b];
    }
    return a;
  }
  // until（祖先）から p までの節点（古い順）
  tail(p: number, until: number): number[] {
    const out: number[] = [];
    for (let q = p; q >= 0 && q !== until; q = this.parent[q]) out.push(q);
    return out.reverse();
  }
}

// 状態の 30 ビットのハッシュ（小さい整数）と、状態が同じか
function hash30(s: Uint8Array): number {
  let a = 0x811c9dc5;
  for (let i = 0; i < SIZE; i++) a = Math.imul(a ^ s[i], 0x01000193);
  return (a ^ (a >>> 15)) & 0x3fffffff;
}
function sameState(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < SIZE; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 状態のハッシュ（53 ビットに収まる数）
function hashOf(s: Uint8Array, len = SIZE): number {
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (let i = 0; i < len; i++) {
    a = Math.imul(a ^ s[i], 0x01000193);
    b = Math.imul(b + s[i], 0x85ebca6b) ^ (b >>> 13);
  }
  return (a >>> 0) * 0x200000 + ((b >>> 0) & 0x1fffff);
}

interface Pass {
  sets: (Map<number, Entry> | null)[]; // 見え方ごとの仮説（つなぐため）
  final: Hyp | null;
  paths: Paths;
  expanded: number;
  reached: number; // 進めた見え方の数
  // 同じ状態に、点数の近い違う手順でたどり着いた（その手は 1 つに決まらない）: 手の木の節点
  ambiguous: Set<number>;
}

// 手 m を状態に: ピースは表を引き、センターの向きは回した面だけ回す（分からなければ分からないまま）
function turn(s: Uint8Array, m: number, t: Uint8Array): void {
  const Q = PERM[m];
  for (let k = 0; k < NUM_PIECES; k++) t[k] = Q[s[k]];
  for (let k = NUM_PIECES; k < SIZE; k++) t[k] = s[k];
  const c = CENTER_SLOT + ((m / 3) | 0);
  if (t[c] !== 4) t[c] = (t[c] + (m % 3) + 1) & 3;
}

function applySeq(s: Uint8Array, seq: number[]): Uint8Array {
  let t: Uint8Array = s.slice();
  for (const mv of seq) {
    const u = new Uint8Array(SIZE);
    turn(t, mv, u);
    t = u;
  }
  return t;
}

// 同じ面の手をまとめ、反対の面の順番をそろえた形（比べるため）
export function canonical(ms: number[]): number[] {
  const out: number[] = [];
  for (const m of ms) {
    const f = Math.floor(m / 3);
    // 直前（反対の面の手は飛ばして）の同じ面の手とまとめる
    let j = out.length - 1;
    if (j >= 0 && Math.floor(out[j] / 3) === OPPOSITE[f]) j--;
    if (j >= 0 && Math.floor(out[j] / 3) === f) {
      const amt = ((out[j] % 3) + 1 + (m % 3) + 1) % 4;
      if (amt) out[j] = f * 3 + amt - 1;
      else out.splice(j, 1);
      continue;
    }
    out.push(m);
  }
  // 反対の面の 2 手は面の番号の小さい方を先に
  for (let i = 0; i + 1 < out.length; i++) {
    const a = Math.floor(out[i] / 3);
    const b = Math.floor(out[i + 1] / 3);
    if (OPPOSITE[a] === b && a > b) [out[i], out[i + 1]] = [out[i + 1], out[i]];
  }
  return out;
}

const newPass = (): Pass => ({ sets: [], final: null, paths: new Paths(), expanded: 0, reached: 0, ambiguous: new Set() });

// 前向き（back なら後ろ向き）に最後まで
function pass(sights: Sight[], start: Uint8Array, end: Uint8Array | null, opt: DecodeOptions, back: boolean): Pass {
  const out = newPass();
  for (const _ of passSteps(sights, start, end, opt, back, out));
  return out;
}

// 見え方を 1 つ進めるごとに止まる（前向きと後ろ向きを交互に進め、つながったら両方やめる: decodePieces）。結果は out に書く
function* passSteps(sights: Sight[], start: Uint8Array, end: Uint8Array | null, opt: DecodeOptions, back: boolean, out: Pass): Generator<number, void, void> {
  const paths = out.paths;
  const ambiguous = out.ambiguous;
  let cur: Hyp[] = [{ s: start.slice(), cost: 0, path: -1 }];
  const sets = out.sets;
  let expanded = 0;
  const steps = end ? sights.length + 1 : sights.length;
  // 終わりの状態: 全部のピースの式（重い）
  const endGroups: SGroup[] = end ? [{ robust: true, n: NUM_PIECES, np: NUM_PIECES, nc: 1, P: Uint8Array.from({ length: NUM_PIECES }, (_, k) => k), A: end.slice(0, NUM_PIECES), prior: new Float32Array(1), W: new Float32Array(NUM_PIECES).fill(opt.endBits), R: new Float32Array(NUM_PIECES).fill(opt.endBits) }] : [];
  let learn: Int8Array = new Int8Array(6).fill(-1);
  let learnAny = false;
  let G: SGroup[] = [];
  const mismatch = (s: Uint8Array): number => {
    let c = 0;
    for (const g of G) c += groupCost(g, s, Infinity);
    return c;
  };
  const unreach = (s: Uint8Array, r: number): number => {
    let c = 0;
    for (const g of G) c += groupBound(g, s, r);
    return c;
  };
  let pool = new Map<number, Hyp & { mis: number; moves: number }>();
  let best = Infinity;
  let mine = Infinity; // いま展開している仮説の、いちばんよい子
  let stayC = Infinity; // いま展開している仮説に手を入れないときのコスト
  const bound = () => Math.min(best + opt.margin, stayC + opt.payback, mine + opt.siblingBits);
  let guessing = false;
  let step = 0;
  const stack = new Uint8Array(32);
  const bufs = Array.from({ length: 32 }, () => new Uint8Array(SIZE));
  // 残すコストの上限: 全体のいちばんから margin まで、かつ、その仮説のいちばんよい子から payback まで
  const offer = (s0: Uint8Array, base: number, depth: number, parent: number): void => {
    let s = s0;
    expanded++;
    const mis = mismatch(s);
    const c = base + mis;
    if (c > bound()) return;
    if (c < mine) mine = c;
    // センターの向きをまだ知らなければ、置き方の決まった面で読めたものに決める
    if (learnAny)
      for (let f = 0; f < 6; f++)
      if (learn[f] >= 0 && s[CENTER_SLOT + f] === 4) {
        s = s.slice();
        for (let g = f; g < 6; g++) if (learn[g] >= 0 && s[CENTER_SLOT + g] === 4) s[CENTER_SLOT + g] = learn[g];
        break;
      }
    // 仮説の入れ物の鍵は 30 ビット（V8 の小さい整数: 53 ビットの数より Map がずっと速い）。ぶつかったら別の鍵へずらす
    let key = hash30(s);
    let old = pool.get(key);
    while (old && !sameState(old.s, s)) {
      key = (key + 0x9e3779b) & 0x3fffffff;
      old = pool.get(key);
    }
    if (old) {
      // 同じ状態に違う手順で着いた: 点数が近ければ（手の少ない方は shorterBits まで）、分かれた所からの手はどちらとも決まらない
      const total = paths.depthOf(parent) + depth;
      const oldTotal = paths.depthOf(old.path);
      const gap = Math.abs(old.cost - c);
      const keepNew = c < old.cost;
      if (opt.mergeAmbiguity && (gap <= opt.ambiguityBits || (total !== oldTotal && gap <= opt.shorterBits))) {
        const root = paths.lca(parent, old.path);
        const mineNodes = paths.tail(parent, root);
        const theirNodes = paths.tail(old.path, root);
        const mineMoves = [...mineNodes.map((q) => paths.info[q] & 31), ...stack.subarray(0, depth)];
        const theirMoves = theirNodes.map((q) => paths.info[q] & 31);
        const keptMoves = keepNew ? mineMoves : theirMoves;
        const otherMoves = keepNew ? theirMoves : mineMoves;
        // 分かれた所の状態: 今の状態から、残す方の手を逆にたどる
        const from = s.slice();
        for (let i = keptMoves.length - 1; i >= 0; i--) {
          const Q = PERM[inverseMove(keptMoves[i])];
          for (let k = 0; k < NUM_PIECES; k++) from[k] = Q[from[k]];
        }
        const unsure = uncertainMoves(keptMoves, otherMoves, from);
        if (unsure.size) {
          if (keepNew) {
            let path = parent;
            const fresh: number[] = [];
            for (let i = 0; i < depth; i++) fresh.push((path = paths.add(path, stack[i], step, guessing)));
            [...mineNodes, ...fresh].forEach((q, j) => unsure.has(j) && ambiguous.add(q));
            pool.set(key, { s: s.slice(), cost: c, path, mis, moves: depth });
            if (c < best) best = c;
            return;
          }
          theirNodes.forEach((q, j) => unsure.has(j) && ambiguous.add(q));
        }
      }
      if (!keepNew) return;
    }
    let path = parent;
    for (let i = 0; i < depth; i++) path = paths.add(path, stack[i], step, guessing);
    pool.set(key, { s: s.slice(), cost: c, path, mis, moves: depth });
    if (c < best) best = c;
  };
  // ちょうど target 手の手順を試す（浅い方から順に呼ぶ: 先に見つかった安い説明で、深い枝を落とせる）
  const dfs = (s: Uint8Array, base: number, depth: number, target: number, lastFace: number, parent: number, budget: number): void => {
    const t = bufs[depth];
    const left = target - depth - 1;
    for (let m = 0; m < 18 && expanded < budget; m++) {
      const x = (m / 3) | 0;
      if (x === lastFace || (lastFace >= 0 && OPPOSITE[x] === lastFace && x < lastFace)) continue;
      turn(s, m, t);
      const c = base + opt.moveBits;
      stack[depth] = m;
      if (left > 0) {
        expanded++;
        if (c + left * opt.moveBits + unreach(t, left) > bound()) continue;
        dfs(t, c, depth + 1, target, x, parent, budget);
      } else offer(t, c, depth + 1, parent);
    }
  };
  // 空白を越える探索（前後半分ずつ）。追うピース（重みの大きい式）の位置の組で突き合わせる。木は型付き配列で持つ
  const BR_CAP = 60000;
  const brPos = new Uint8Array(BR_CAP * 10);
  const brParent = new Int32Array(BR_CAP);
  const brMove = new Int8Array(BR_CAP);
  const brDepth = new Uint8Array(BR_CAP);
  const frPos = new Uint8Array(BR_CAP * 10);
  const frParent = new Int32Array(BR_CAP);
  const frMove = new Int8Array(BR_CAP);
  const frDepth = new Uint8Array(BR_CAP);
  const keyAt = (buf: Uint8Array, off: number, m: number, skip: number): number => {
    let a = 0x811c9dc5;
    let b = 0x1b873593;
    for (let j = 0; j < m; j++) {
      const v = j === skip ? 255 : buf[off + j];
      a = Math.imul(a ^ v, 0x01000193);
      b = Math.imul(b + v, 0x85ebca6b) ^ (b >>> 13);
    }
    return (a >>> 0) * 0x200000 + ((b >>> 0) & 0x1fffff);
  };
  // 根から広げた木（inv: 逆向きの手）。位置の組が同じ節点は 1 つだけ
  const growTree = (pos: Uint8Array, parent: Int32Array, mv: Int8Array, dep: Uint8Array, root: ArrayLike<number>, m: number, depth: number, inv: boolean): number => {
    for (let k = 0; k < m; k++) pos[k] = root[k];
    parent[0] = -1;
    mv[0] = -1;
    dep[0] = 0;
    let count = 1;
    const seen = new Set<number>([keyAt(pos, 0, m, -1)]);
    for (let i = 0; i < count && count < BR_CAP; i++) {
      if (dep[i] >= depth) continue;
      const last = mv[i] < 0 ? -1 : (mv[i] / 3) | 0;
      for (let x = 0; x < 18 && count < BR_CAP; x++) {
        const f = (x / 3) | 0;
        if (f === last || (last >= 0 && OPPOSITE[f] === last && (inv ? f > last : f < last))) continue;
        const Q = PERM[inv ? inverseMove(x) : x];
        const o = count * m;
        for (let k = 0; k < m; k++) pos[o + k] = Q[pos[i * m + k]];
        const key = keyAt(pos, o, m, -1);
        if (seen.has(key)) continue;
        seen.add(key);
        parent[count] = i;
        mv[count] = x;
        dep[count] = dep[i] + 1;
        count++;
      }
    }
    expanded += count;
    return count;
  };
  const bridge = (from: Hyp[], minLen: number): void => {
    // 追う式: 既定の置き方の、重み trackBits 以上の読み（ピースごとに重さを足す）
    const track = new Map<number, { x: number; w: number }>();
    for (const g of G)
      for (let i = 0; i < g.n; i++) {
        const x = g.A[i];
        if (x === 255 || g.P[i] >= NUM_PIECES) continue;
        const o = track.get(g.P[i]);
        if (!o || o.w < g.W[i]) track.set(g.P[i], { x, w: (o?.x === x ? o.w : 0) + g.W[i] });
      }
    const tp = [...track].filter(([, v]) => v.w >= opt.trackBits).sort((a, b) => b[1].w - a[1].w).slice(0, 10);
    if (tp.length < opt.bridgePieces) return;
    const m = tp.length;
    const half = Math.ceil(opt.bridgeMoves / 2);
    // 後ろ側: 追うピースの目標の位置から逆向きに広げる。全部合うもの（表 0）と、1 つだけ外したもの（表 1..m: そのピースは見ない）
    const bCount = growTree(brPos, brParent, brMove, brDepth, tp.map(([, v]) => v.x), m, opt.bridgeMoves - half, true);
    const tables: Map<number, number>[] = [];
    const skips = Math.min(m, opt.bridgeSkips);
    for (let skip = -1; skip < skips; skip++) {
      const tb = new Map<number, number>();
      for (let i = 0; i < bCount; i++) {
        const k = keyAt(brPos, i * m, m, skip);
        if (!tb.has(k)) tb.set(k, i);
      }
      tables.push(tb);
    }
    // 前側: 仮説から広げ、表と突き合わせる
    const found: { h: Hyp; seq: number[]; cost: number }[] = [];
    const seenSeq = new Set<string>();
    for (const h of from) {
      const fCount = growTree(frPos, frParent, frMove, frDepth, tp.map(([k]) => h.s[k]), m, half, false);
      for (let i = 0; i < fCount; i++)
        for (let skip = -1; skip < skips; skip++) {
          const hit = tables[skip + 1].get(keyAt(frPos, i * m, m, skip));
          if (hit === undefined) continue;
          const len = frDepth[i] + brDepth[hit];
          if (len < minLen) continue;
          const seq: number[] = [];
          for (let q = i; frParent[q] >= 0; q = frParent[q]) seq.push(frMove[q]);
          seq.reverse();
          for (let q = hit; brParent[q] >= 0; q = brParent[q]) seq.push(brMove[q]);
          const key = `${h.path}:${seq.join()}`;
          if (seenSeq.has(key)) continue;
          seenSeq.add(key);
          const t = applySeq(h.s, seq);
          found.push({ h, seq, cost: h.cost + seq.length * opt.moveBits + mismatch(t) });
        }
    }
    found.sort((a, b) => a.cost - b.cost);
    guessing = true;
    for (const f of found.slice(0, opt.bridgeKeep)) {
      for (let i = 0; i < f.seq.length; i++) stack[i] = f.seq[i];
      mine = Infinity;
      stayC = Infinity;
      offer(applySeq(f.h.s, f.seq), f.h.cost + f.seq.length * opt.moveBits, f.seq.length, f.h.path);
    }
    guessing = false;
  };
  let final: Hyp | null = null;
  const health: { t: number; v: number }[] = [];
  let reached = 0;
  for (step = 0; step < steps; step++) {
    const last = step === sights.length;
    let maxDepth: number;
    if (last) {
      G = endGroups;
      learn = new Int8Array(6).fill(-1);
      learnAny = false;
      maxDepth = opt.endMoves;
    } else {
      const sg = sights[step];
      G = sg.groups;
      learn = sg.learn;
      learnAny = learn.some((x) => x >= 0);
      const gap = step === 0 ? 0 : Math.abs(sg.t0 - sights[step - 1].t1);
      maxDepth = Math.min(opt.maxMoves, opt.minMoves + Math.floor(gap / opt.msPerMove));
    }
    pool = new Map();
    best = Infinity;
    // 手を入れないものから（候補のコストが早く決まり、枝を落とせる）
    const stay = new Float64Array(cur.length);
    for (let i = 0; i < cur.length; i++) {
      mine = Infinity;
      stayC = Infinity;
      offer(cur[i].s, cur[i].cost, 0, cur[i].path);
      stay[i] = cur[i].cost + mismatch(cur[i].s);
    }
    if (opt.deadline !== undefined && performance.now() > opt.deadline) {
      PROFILE.capped++;
      break;
    }
    const budget = expanded + opt.nodeCap;
    const d0 = performance.now();
    const e0 = expanded;
    const order = Array.from(cur, (_, i) => i).sort((x, y) => stay[x] - stay[y]);
    for (let oi = 0; oi < order.length && expanded < budget; oi++) {
      const h = cur[order[oi]];
      mine = stay[order[oi]];
      stayC = stay[order[oi]];
      const deepest = oi < opt.deepHyps ? (last ? opt.endMoves : Math.max(maxDepth, opt.maxMoves)) : Math.min(maxDepth, 3);
      for (let L = 1; L <= deepest && expanded < budget; L++) {
        if (h.cost + L * opt.moveBits + unreach(h.s, L) > bound()) continue;
        dfs(h.s, h.cost, 0, L, -1, h.path, budget);
      }
    }
    PROFILE.dfsMs += performance.now() - d0;
    PROFILE.dfsNodes += expanded - e0;
    PROFILE.steps++;
    if (expanded >= budget) PROFILE.capped++;
    // ふつうの探索で説明がつかない: 空白を越える探索
    if (!last && opt.bridgeMoves > opt.maxMoves) {
      let top: (Hyp & { mis: number }) | null = null;
      for (const h of pool.values()) if (!top || h.cost < top.cost) top = h;
      if (top && top.mis >= opt.stuckBits && top.mis >= opt.stuckShare * sights[step].weight) {
        const b0 = performance.now();
        const e0 = expanded;
        bridge(order.slice(0, opt.bridgeHyps).map((i) => cur[i]), opt.maxMoves + 1);
        PROFILE.bridgeMs += performance.now() - b0;
        PROFILE.bridgeNodes += expanded - e0;
        PROFILE.bridges++;
      }
    }
    let all = [...pool.values()].filter((h) => h.cost <= best + opt.margin);
    if (all.length > opt.beam) {
      all.sort((a, b) => a.cost - b.cost);
      all.length = opt.beam;
    }
    cur = all;
    if (!cur.length) break;
    reached = step + 1;
    if (opt.onStep) {
      const b = cur.reduce((x, y) => (x.cost <= y.cost ? x : y)) as Hyp & { mis: number };
      opt.onStep({ back, step, t: last ? Number.NaN : Math.abs(sights[step].t0), readings: last ? 0 : sights[step].readings, depth: maxDepth, hyps: cur.length, best, mis: b.mis, expanded, moves: paths.list(b.path).map((x) => x.move) });
    }
    if (last) {
      final = cur.find((h) => h.s.every((y, k) => y === end![k])) ?? null;
      break;
    }
    // つなぐために覚える（いちばん安いものから keep 個）
    const top = cur.length > opt.keep ? [...cur].sort((a, b) => a.cost - b.cost).slice(0, opt.keep) : cur;
    const set = new Map<number, Entry>();
    for (const h of top as (Hyp & { mis: number })[]) {
      const k = hashOf(h.s, NUM_PIECES);
      const o = set.get(k);
      if (!o || o.cost > h.cost) set.set(k, { cost: h.cost, path: h.path, mis: h.mis, s: h.s });
    }
    sets.push(set);
    // 見失ったらやめる: 食い違い（コスト − 手）が直近 lostMs で lostBits 以上増えた
    let bestH = cur[0];
    for (const h of cur) if (h.cost < bestH.cost) bestH = h;
    const v = bestH.cost - paths.depthOf(bestH.path) * opt.moveBits;
    const t = Math.abs(sights[step].t1);
    health.push({ t, v });
    let j = health.length - 1;
    while (j > 0 && t - health[j - 1].t <= opt.lostMs) j--;
    if (v - health[j].v >= opt.lostBits) break;
    out.expanded = expanded;
    out.reached = reached;
    yield step;
  }
  out.expanded = expanded;
  out.reached = reached;
  out.final = final;
}

export function decodePieces(table: PieceTable, start: CubeState, end: CubeState, options: Partial<DecodeOptions> = {}): DecodeResult {
  const opt = { ...DEFAULT_DECODE, ...options };
  const began = performance.now();
  const sights = buildSights(table, opt);
  const n = sights.length;
  const a = withCenters(piecesOf(start));
  const b = withCenters(piecesOf(end));
  // 前向き（始まりから）と後ろ向き（見え方を逆順に、時刻の向きも逆に、終わりの状態から）を 1 歩ずつ交互に進め、同じ見え方で同じ状態に
  // なったら（つながった）、両方とももう少し（afterMeetMs）進めてやめる。つながらなければ、見失うか端まで
  const rev = sights.map((s) => ({ ...s, t0: -s.t1, t1: -s.t0 })).reverse();
  const fw = newPass();
  const bw = newPass();
  const fg = passSteps(sights, a, b, opt, false, fw);
  const bg = passSteps(rev, b, a, opt, true, bw);
  let fDone = false;
  let bDone = false;
  let metT = Number.NaN;
  const meetsAt = (i: number) => {
    const F = fw.sets[i];
    const B = bw.sets[n - 1 - i];
    if (!F || !B) return false;
    for (const k of F.keys()) if (B.has(k)) return true;
    return false;
  };
  let fT = Number.NEGATIVE_INFINITY;
  let bT = Number.POSITIVE_INFINITY;
  while (!fDone || !bDone) {
    if (!fDone && (bDone || fw.sets.length <= bw.sets.length)) {
      const r = fg.next();
      if (r.done) fDone = true;
      else if (r.value < n) {
        fT = sights[r.value].t1;
        if (Number.isNaN(metT) && meetsAt(r.value)) metT = sights[r.value].t0;
      }
    } else {
      const r = bg.next();
      if (r.done) bDone = true;
      else if (r.value < n) {
        bT = sights[n - 1 - r.value].t0;
        if (Number.isNaN(metT) && meetsAt(n - 1 - r.value)) metT = sights[n - 1 - r.value].t0;
      }
    }
    if (!Number.isNaN(metT) && (fDone || fT - metT >= opt.afterMeetMs) && (bDone || metT - bT >= opt.afterMeetMs)) break;
    // 時間の上限: つながっていればそこまでで、つながっていなければあきらめる（呼ぶ側はこれまでの解き直しに戻す）
    if (performance.now() - began > opt.budgetMs) {
      if (Number.isNaN(metT)) return { sights: n, expanded: fw.expanded + bw.expanded, moves: [], reachedEnd: false, method: "none", cost: Infinity, ms: performance.now() - began, alternatives: 0, timedOut: true };
      break;
    }
  }
  const info = { sights: n, expanded: fw.expanded + bw.expanded, forwardTo: fw.reached ? sights[Math.min(fw.reached, n) - 1]?.t1 : undefined, backwardTo: bw.reached ? sights[Math.max(0, n - bw.reached)]?.t0 : undefined };
  // 前向きの手の列 → 見え方の番号つき
  const fMoves = (path: number): M[] => {
    const out: M[] = [];
    for (let p = path; p >= 0; p = fw.paths.parent[p]) out.push({ move: fw.paths.info[p] & 31, sight: fw.paths.info[p] >> 6, guess: (fw.paths.info[p] & 32) !== 0, amb: fw.ambiguous.has(p) });
    return out.reverse();
  };
  // 後ろ向きの手: 逆順の見え方 j（= 元の n − 1 − j）の前の手は、元の見え方 n − j の前の手。逆向きにして順番も逆に
  const bMoves = (path: number): M[] => {
    const out: M[] = [];
    for (let p = path; p >= 0; p = bw.paths.parent[p]) out.push({ move: inverseMove(bw.paths.info[p] & 31), sight: n - (bw.paths.info[p] >> 6), guess: (bw.paths.info[p] & 32) !== 0, amb: bw.ambiguous.has(p) });
    return out;
  };
  // つなぎ方: 見え方 i で同じ状態（見え方 i の食い違いは両方に入っているので 1 回引く）
  const meets: { cost: number; i: number; f: Entry; b: Entry }[] = [];
  for (let i = 0; i < n; i++) {
    const F = fw.sets[i];
    const B = bw.sets[n - 1 - i];
    if (!F || !B) continue;
    for (const [key, x] of F) {
      const y = B.get(key);
      if (y) meets.push({ cost: x.cost + y.cost - x.mis, i, f: x, b: y });
    }
  }
  meets.sort((p, q) => p.cost - q.cost);
  const fCost = fw.final ? fw.final.cost : Infinity;
  const bCost = bw.final ? bw.final.cost : Infinity;
  let chosen: M[] | null = null;
  let method: DecodeResult["method"] = "none";
  let cost = Infinity;
  const alts: { cost: number; moves: M[] }[] = [];
  if (meets.length && meets[0].cost <= fCost && meets[0].cost <= bCost) {
    chosen = [...fMoves(meets[0].f.path), ...bMoves(meets[0].b.path)];
    method = "meet";
    cost = meets[0].cost;
    for (const m of meets.slice(1)) {
      if (m.cost > cost + Math.max(opt.ambiguityBits, opt.shorterBits)) break;
      alts.push({ cost: m.cost, moves: [...fMoves(m.f.path), ...bMoves(m.b.path)] });
    }
  } else if (fw.final && fCost <= bCost) {
    chosen = fMoves(fw.final.path);
    method = "forward";
    cost = fCost;
  } else if (bw.final) {
    chosen = bMoves(bw.final.path);
    method = "backward";
    cost = bCost;
  }
  if (!chosen) return { ...info, moves: [], reachedEnd: false, method: "none", cost: Infinity, ms: performance.now() - began, alternatives: 0 };
  // 答えの確かめ: 読みのはっきりした見え方の間ごとに、別の手順を漏れなく探す
  let verified = { replaced: 0, unsure: 0, unchecked: 0, segments: 0, ms: 0, decodeMs: performance.now() - began };
  if (opt.verify) {
    const v0 = performance.now();
    // 確かめの時間: verifyMs まで、かつ解き直し全体で totalMs まで
    const v = verifyPath(sights, a, b, chosen, { ...opt, verifyMs: Math.max(0, Math.min(opt.verifyMs, opt.totalMs - (performance.now() - began))) });
    chosen = v.moves;
    verified = { ...v.stats, ms: Math.round(performance.now() - v0), decodeMs: Math.round(verified.decodeMs) };
  }
  // 答えが 1 つに決まったか: 点数の近い別の解（手の少ないものは shorterBits まで）と、まとめた形で合わない手は inferred
  const unsure = new Set<number>();
  const mineSeq = chosen.map((m) => m.move);
  const mineC = canonical(mineSeq);
  const seenAlt = new Set<string>([mineC.join()]);
  let used = 0;
  for (const alt of alts) {
    const theirs = alt.moves.map((m) => m.move);
    const k = canonical(theirs).join();
    if (seenAlt.has(k)) continue;
    seenAlt.add(k);
    const shorter = canonical(theirs).length < mineC.length;
    if (alt.cost - cost > (shorter ? opt.shorterBits : opt.ambiguityBits)) continue;
    used++;
    for (const j of uncertainMoves(mineSeq, theirs, a)) unsure.add(j);
  }
  const timed = (m: M, j: number): DecodedPieceMove => {
    const i = m.sight;
    const before = i > 0 ? sights[Math.min(i, n) - 1].t1 : (sights[0]?.t0 ?? 0);
    const after = i < n ? sights[i].t0 : (sights[n - 1]?.t1 ?? 0);
    const inferred = i >= n || i === 0 || m.guess || m.amb || unsure.has(j);
    return { move: m.move, sight: i, t0: Math.min(before, after), t: after, ...(inferred ? { inferred: true } : {}) };
  };
  return { ...info, moves: chosen.map(timed), reachedEnd: true, method, cost, ms: performance.now() - began, alternatives: used, verified, ...(method === "meet" ? { meetAt: sights[meets[0].i].t0 } : {}) };
}

// 答えの手（見え方の番号つき）
type M = { move: number; sight: number; guess: boolean; amb: boolean };

// 見え方 sg の、状態 s での食い違いと、合った読みの重み。robust: 置き方が推測に頼らないまとまりだけ
function sightFit(sg: Sight, s: Uint8Array, robust = false, whole = false): { mis: number; support: number } {
  let mis = 0;
  let weight = 0;
  for (const g of sg.groups) {
    if (robust && !g.robust) continue;
    mis += groupCost(g, s, Infinity, whole);
    for (let i = 0; i < g.n; i++) weight += whole ? g.R[i] : g.W[i];
  }
  return { mis, support: weight - mis };
}

// 手順 seq（状態 from から）を、見え方 sights[i0..i1) の間にいちばん合うように割り振ったときの、手 + 食い違い。
// 最後の見え方 i1 は全部の手を入れた後の状態で数える（i1 < 0 なら数えない）。割り振り（手 k の後の見え方の番号）も返す
function placeSeq(sights: Sight[], i0: number, i1: number, last: number, from: Uint8Array, seq: number[], opt: DecodeOptions, robust = false): { cost: number; at: number[] } {
  const L = seq.length;
  const states: Uint8Array[] = [from];
  for (const m of seq) states.push(applySeq(states[states.length - 1], [m]));
  const INF = Number.POSITIVE_INFINITY;
  // cost[k]: 見え方 i の時点で k 手を入れた
  let cost = new Float64Array(L + 1).fill(INF);
  cost[0] = 0;
  const choice: Int32Array[] = [];
  for (let i = i0; i < i1; i++) {
    const next = new Float64Array(L + 1).fill(INF);
    const from_ = new Int32Array(L + 1).fill(-1);
    for (let k = 0; k <= L; k++) {
      // k0 → k（cost は単調に最小をとる）
      for (let k0 = 0; k0 <= k; k0++)
        if (cost[k0] < next[k]) {
          next[k] = cost[k0];
          from_[k] = k0;
        }
    }
    for (let k = 0; k <= L; k++) if (next[k] < INF) next[k] += sightFit(sights[i], states[k], robust).mis;
    cost = next;
    choice.push(from_);
  }
  // 中の見え方の後に残った手は、錨の見え方 i1 の前に入れる
  let best = INF;
  let kEnd = L;
  for (let k = 0; k <= L; k++)
    if (cost[k] < best) {
      best = cost[k];
      kEnd = k;
    }
  const tail = last >= 0 ? sightFit(sights[last], states[L], robust).mis : 0;
  // 割り振り: 後ろからたどる
  const at = new Array<number>(L).fill(i1);
  let k = kEnd;
  for (let i = i1 - 1; i >= i0; i--) {
    const k0 = choice[i - i0][k];
    for (let j = k0; j < k; j++) at[j] = i;
    k = k0;
  }
  // 見え方 i の「前」に入れた手は、見え方 i の番号（手 j が見え方 i で初めて効く）
  return { cost: best + L * opt.moveBits + tail, at };
}

// 状態 A から状態 B（ピースの位置）への、長さ maxLen までの手順を全部（まとめた形で重ならないもの）
function sequencesBetween(A: Uint8Array, B: Uint8Array, maxLen: number, cap: number): number[][] {
  const d1 = Math.ceil(maxLen / 2);
  const d2 = maxLen - d1;
  type Tree = { pos: Uint8Array[]; parent: number[]; move: number[]; depth: number[] };
  const grow = (root: Uint8Array, depth: number, inv: boolean): Tree => {
    const t: Tree = { pos: [root.slice(0, NUM_PIECES)], parent: [-1], move: [-1], depth: [0] };
    for (let i = 0; i < t.pos.length; i++) {
      if (t.depth[i] >= depth) continue;
      const last = t.move[i] < 0 ? -1 : (t.move[i] / 3) | 0;
      for (let mv = 0; mv < 18; mv++) {
        const x = (mv / 3) | 0;
        if (x === last || (last >= 0 && OPPOSITE[x] === last && (inv ? x > last : x < last))) continue;
        const Q = PERM[inv ? inverseMove(mv) : mv];
        const p = new Uint8Array(NUM_PIECES);
        for (let k = 0; k < NUM_PIECES; k++) p[k] = Q[t.pos[i][k]];
        t.pos.push(p);
        t.parent.push(i);
        t.move.push(mv);
        t.depth.push(t.depth[i] + 1);
      }
    }
    return t;
  };
  const F = grow(A, d1, false);
  const Bt = grow(B, d2, true);
  const index = new Map<number, number[]>();
  F.pos.forEach((p, i) => {
    const h = hashOf(p, NUM_PIECES);
    const l = index.get(h);
    if (l) l.push(i);
    else index.set(h, [i]);
  });
  const out: number[][] = [];
  const seen = new Set<string>();
  for (let j = 0; j < Bt.pos.length && out.length < cap; j++) {
    const l = index.get(hashOf(Bt.pos[j], NUM_PIECES));
    if (!l) continue;
    for (const i of l) {
      if (F.depth[i] + Bt.depth[j] > maxLen) continue;
      const seq: number[] = [];
      for (let p = i; F.parent[p] >= 0; p = F.parent[p]) seq.push(F.move[p]);
      seq.reverse();
      for (let p = j; Bt.parent[p] >= 0; p = Bt.parent[p]) seq.push(Bt.move[p]);
      // 同じ面が続く・打ち消し合うつなぎ目はまとめた形が別の短い手順になる（それ自体も別に見つかる）
      const c = canonical(seq);
      if (c.length !== seq.length) continue;
      const k = c.join();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(seq);
    }
  }
  return out;
}

// 区間（見え方 sub、始まりの状態 A、終わりの状態 B）を、幅を広げた前向き・後ろ向きで解き直し、つながる手順をコストの小さい方から集める
function segmentAlternatives(sub: Sight[], A: Uint8Array, B: Uint8Array, opt: DecodeOptions): number[][] | null {
  const o2: DecodeOptions = { ...opt, beam: opt.verifyBeam, keep: opt.verifyBeam, margin: opt.margin + opt.verifyBits, deepHyps: opt.deepHyps * 2, siblingBits: opt.siblingBits + opt.verifyBits / 2, payback: opt.payback + opt.verifyBits / 2, lostBits: Infinity, nodeCap: opt.verifyNodes, onStep: undefined };
  const n = sub.length;
  const before = PROFILE.capped;
  const fw = pass(sub, A, B, o2, false);
  const rev = sub.map((x) => ({ ...x, t0: -x.t1, t1: -x.t0 })).reverse();
  const bw = pass(rev, B, A, o2, true);
  // 候補が多すぎて打ち切った見え方があれば、漏れがありうる: 確かめられない
  if (PROFILE.capped > before) return null;
  const fSeq = (p: number) => {
    const out: number[] = [];
    for (let q = p; q >= 0; q = fw.paths.parent[q]) out.push(fw.paths.info[q] & 31);
    return out.reverse();
  };
  const bSeq = (p: number) => {
    const out: number[] = [];
    for (let q = p; q >= 0; q = bw.paths.parent[q]) out.push(inverseMove(bw.paths.info[q] & 31));
    return out;
  };
  const found: { cost: number; q: number[] }[] = [];
  for (let i = 0; i < n; i++) {
    const F = fw.sets[i];
    const Bs = bw.sets[n - 1 - i];
    if (!F || !Bs) continue;
    for (const [key, x] of F) {
      const y = Bs.get(key);
      if (y) found.push({ cost: x.cost + y.cost - x.mis, q: [...fSeq(x.path), ...bSeq(y.path)] });
    }
  }
  if (fw.final) found.push({ cost: fw.final.cost, q: fSeq(fw.final.path) });
  if (bw.final) found.push({ cost: bw.final.cost, q: bSeq(bw.final.path) });
  found.sort((x, y) => x.cost - y.cost);
  const out: number[][] = [];
  const seen = new Set<string>();
  for (const f of found) {
    const k = canonical(f.q).join();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(canonical(f.q));
    if (out.length >= 64) break;
  }
  return out;
}

// 答えの確かめ（DecodeOptions.verify）
function verifyPath(sights: Sight[], start: Uint8Array, end: Uint8Array, moves: M[], opt: DecodeOptions): { moves: M[]; stats: { replaced: number; unsure: number; unchecked: number; segments: number } } {
  const n = sights.length;
  const vStart = performance.now();
  const stats = { replaced: 0, unsure: 0, unchecked: 0, segments: 0 };
  // 見え方ごとの、答えの状態（センターの向きは前向きと同じく、置き方の決まった面で初めて読めたときに決める）
  const states: Uint8Array[] = [];
  let s: Uint8Array = start.slice();
  let j = 0;
  const learnInto = (x: Uint8Array, sg: Sight) => {
    for (let f = 0; f < 6; f++) if (sg.learn[f] >= 0 && x[CENTER_SLOT + f] === 4) x[CENTER_SLOT + f] = sg.learn[f];
  };
  for (let i = 0; i < n; i++) {
    while (j < moves.length && moves[j].sight <= i) s = applySeq(s, [moves[j++].move]);
    s = s.slice();
    learnInto(s, sights[i]);
    states.push(s);
  }
  // 錨: 読みがはっきり支える見え方
  const anchors: number[] = [-1];
  for (let i = 0; i < n; i++) {
    const f = sightFit(sights[i], states[i], true, true);
    if (f.support < opt.anchorBits || f.mis > opt.anchorMis) continue;
    // どの 1 手を足しても読みと食い違う（その見え方で状態が決まっている）こと。見えない層の手を足した状態も同じように合うなら、錨にしない
    // （見えない層の余分な手が錨の状態に入ったまま「確かめた」ことになった）
    let pinned = true;
    const t = new Uint8Array(SIZE);
    for (let m = 0; m < 18 && pinned; m++) {
      turn(states[i], m, t);
      if (sightFit(sights[i], t, true, true).mis - f.mis < opt.pinBits) pinned = false;
    }
    if (pinned) anchors.push(i);
  }
  anchors.push(n);
  const out: M[] = [];
  for (let k = 0; k + 1 < anchors.length; k++) {
    const a = anchors[k];
    const bIdx = anchors[k + 1];
    // 錨 a の後〜錨 b の前（b の見え方の前）に入れた手。終わり（b = n）は最後の見え方の後の手も
    const seg = moves.filter((m) => m.sight > a && (bIdx === n ? true : m.sight <= bIdx));
    if (!seg.length) continue;
    stats.segments++;
    const A = a < 0 ? start : states[a];
    const B = bIdx === n ? end : states[bIdx];
    const lastSight = bIdx === n ? -1 : bIdx;
    const i0 = a + 1;
    const i1 = bIdx === n ? n : bIdx;
    const mine = seg.map((m) => m.move);
    // 間の手が少なければ漏れなく、多ければ（verifyLong 手まで）その区間だけを幅を広げて前後から解き直して、別の手順を集める
    let cands: number[][] | null = null;
    const inTime = performance.now() - vStart < opt.verifyMs;
    if (inTime && seg.length <= opt.verifyMoves) cands = sequencesBetween(A, B, mine.length + 1, 4000);
    else if (inTime && seg.length <= opt.verifyLong) {
      const s0 = performance.now();
      cands = segmentAlternatives(sights.slice(i0, i1), A, B, { ...opt, deadline: vStart + opt.verifyMs });
      opt.debugVerify?.(`  区間の解き直し ${seg.length} 手・見え方 ${i1 - i0}・${(performance.now() - s0).toFixed(0)}ms${cands ? "" : "（打ち切り）"}`);
    }
    if (!cands) {
      opt.debugVerify?.(`錨 ${a < 0 ? "始め" : (sights[a].t0 / 1000).toFixed(2)}〜${bIdx === n ? "終わり" : (sights[bIdx].t0 / 1000).toFixed(2)} 手 ${seg.length}: 確かめられない`);
      stats.unchecked += seg.length;
      for (const m of seg) out.push({ ...m, amb: true });
      continue;
    }
    const scored = cands.map((q) => ({ q, ...placeSeq(sights, i0, i1, lastSight, A, q, opt) }));
    scored.sort((x, y) => x.cost - y.cost);
    const own = placeSeq(sights, i0, i1, lastSight, A, mine, opt);
    let best = { q: mine, cost: own.cost, at: own.at };
    if (scored.length && scored[0].cost < own.cost - opt.verifyBits) {
      best = scored[0];
      stats.replaced++;
    }
    // 1 つに決まったか: 推測に頼らない読みだけの点数で、verifyBits 以内の別の手順（手の少ないものは shorterBits まで）と違う手
    const bestC = canonical(best.q).join();
    const robustOf = (q: number[]) => placeSeq(sights, i0, i1, lastSight, A, q, opt, true).cost;
    const rb = robustOf(best.q);
    const unsure = new Set<number>();
    for (const x of scored) {
      if (canonical(x.q).join() === bestC) continue;
      const shorter = canonical(x.q).length < canonical(best.q).length;
      const gap = Math.min(x.cost - best.cost, robustOf(x.q) - rb);
      if (gap > (shorter ? Math.max(opt.verifyBits, opt.shorterBits) : opt.verifyBits)) continue;
      for (const u of uncertainMoves(best.q, x.q, A)) unsure.add(u);
    }
    stats.unsure += unsure.size;
    if (opt.debugVerify) {
      const nm = (q: number[]) => q.map((m) => "URFDLB"[(m / 3) | 0] + ["", "2", "'"][m % 3]).join(" ");
      const alts = scored.filter((x) => canonical(x.q).join() !== bestC).slice(0, 3).map((x) => `${nm(x.q)} ${(x.cost - best.cost).toFixed(1)}/${(robustOf(x.q) - rb).toFixed(1)}`);
      opt.debugVerify(`錨 ${a < 0 ? "始め" : (sights[a].t0 / 1000).toFixed(2)}〜${bIdx === n ? "終わり" : (sights[bIdx].t0 / 1000).toFixed(2)} 手 [${nm(mine)}]${best.q !== mine ? ` → [${nm(best.q)}]` : ""} 候補 ${scored.length} 決まらない ${unsure.size}・別: ${alts.join(" | ")}`);
    }
    if (best.q === mine) seg.forEach((m, i) => out.push(unsure.has(i) ? { ...m, amb: true } : m));
    else best.q.forEach((mv, i) => out.push({ move: mv, sight: Math.max(a + 1, best.at[i]), guess: false, amb: unsure.has(i) }));
  }
  out.sort((x, y) => x.sight - y.sight);
  return { moves: stableBySight(out, moves), stats };
}

// 見え方の番号の順（同じ見え方の中は元の順）
function stableBySight(out: M[], _orig: M[]): M[] {
  return out.map((m, i) => ({ m, i })).sort((x, y) => x.m.sight - y.m.sight || x.i - y.i).map((x) => x.m);
}

// kept と other（どちらも状態 from から同じ状態へ着く手順）を比べ、kept の手のうち、other にも同じ状態から同じ状態への動きがないもの
// （元の番号）。まとめた形で比べる（反対の面の 2 手の順番・同じ面の続きは同じとみなす）。違う手順が同じ所を通っていれば、そこまでの手は
// どちらでも同じ（R2 U2 R2 と U2 R2 U2 は同じ状態になるが、間の状態はどれも違うので 3 手とも決まらない）
export function uncertainMoves(kept: number[], other: number[], from: Uint8Array): Set<number> {
  const a = canonicalWithIndex(kept);
  const b = canonicalWithIndex(other);
  const out = new Set<number>();
  if (a.length === b.length && a.every((x, i) => x.m === b[i].m)) return out;
  const trans = new Set<string>();
  let s: Uint8Array = from.slice();
  let h = hashOf(s, NUM_PIECES);
  for (const x of b) {
    s = applySeq(s, [x.m]);
    const h2 = hashOf(s, NUM_PIECES);
    trans.add(`${h}:${h2}`);
    h = h2;
  }
  s = from.slice();
  h = hashOf(s, NUM_PIECES);
  for (const x of a) {
    s = applySeq(s, [x.m]);
    const h2 = hashOf(s, NUM_PIECES);
    if (!trans.has(`${h}:${h2}`)) for (const j of x.idx) out.add(j);
    h = h2;
  }
  return out;
}

// まとめた形（canonical と同じ）と、まとめた手がどの元の手から来たか
export function canonicalWithIndex(ms: number[]): { m: number; idx: number[] }[] {
  const out: { m: number; idx: number[] }[] = [];
  ms.forEach((m, k) => {
    const f = Math.floor(m / 3);
    let j = out.length - 1;
    if (j >= 0 && Math.floor(out[j].m / 3) === OPPOSITE[f]) j--;
    if (j >= 0 && Math.floor(out[j].m / 3) === f) {
      const amt = ((out[j].m % 3) + 1 + (m % 3) + 1) % 4;
      if (amt) out[j] = { m: f * 3 + amt - 1, idx: [...out[j].idx, k] };
      else {
        // 打ち消し合って消えた: どちらの手も、相手の解と比べようがないので印だけ残す（次の手にまとめる）
        const gone = out.splice(j, 1)[0];
        const next = out[j];
        if (next) next.idx.push(...gone.idx, k);
      }
      return;
    }
    out.push({ m, idx: [k] });
  });
  for (let i = 0; i + 1 < out.length; i++) {
    const a = Math.floor(out[i].m / 3);
    const b = Math.floor(out[i + 1].m / 3);
    if (OPPOSITE[a] === b && a > b) [out[i], out[i + 1]] = [out[i + 1], out[i]];
  }
  return out;
}

// a の各要素が、b のどれと対応するか（最長共通部分列。対応しなければ -1）
export function alignment(a: number[], b: number[]): number[] {
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = new Array<number>(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out[i] = j;
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return out;
}

export type { FrameEq };

// 調査用: 決まった手順 moves の点数（手を見え方の間にいちばん合うように割り振ったときの、手 + 食い違い）と、見え方ごとの食い違い。
// 正解の手順の点数が解き直しの答えより低ければ探索の取りこぼし、高ければ点数の付け方の問題
export function scoreMoves(table: PieceTable, start: CubeState, end: CubeState, moves: number[], options: Partial<DecodeOptions> = {}): { cost: number; perSight: { t: number; k: number; mis: number }[] } {
  const opt = { ...DEFAULT_DECODE, ...options };
  const sights = buildSights(table, opt);
  const n = moves.length;
  const states: Uint8Array[] = [withCenters(piecesOf(start))];
  for (const m of moves) states.push(applySeq(states[states.length - 1], [m]));
  // センターの向き: 置き方の決まった面で最初に読めたとき、そのとき一番安い手の数 k の状態で決め、ほかの k は回した回数から
  const turnsBefore = (k: number, f: number) => {
    let x = 0;
    for (let j = 0; j < k; j++) if (((moves[j] / 3) | 0) === f) x += (moves[j] % 3) + 1;
    return x;
  };
  const INF = Number.POSITIVE_INFINITY;
  let cost = new Float64Array(n + 1).fill(INF);
  cost[0] = 0;
  const back: Int32Array[] = [];
  const mis: Float64Array[] = [];
  for (let i = 0; i < sights.length; i++) {
    const sg = sights[i];
    const next = new Float64Array(n + 1).fill(INF);
    const from = new Int32Array(n + 1).fill(-1);
    for (let k = 0; k <= n; k++)
      for (let k0 = Math.max(0, k - 8); k0 <= k; k0++) {
        if (cost[k0] === INF) continue;
        const c = cost[k0] + (k - k0) * opt.moveBits;
        if (c < next[k]) {
          next[k] = c;
          from[k] = k0;
        }
      }
    for (let f = 0; f < 6; f++) {
      if (sg.learn[f] < 0 || states[0][CENTER_SLOT + f] !== 4) continue;
      let kb = 0;
      for (let k = 1; k <= n; k++) if (next[k] < next[kb]) kb = k;
      const phi0 = (sg.learn[f] - turnsBefore(kb, f) + 400) & 3;
      for (let k = 0; k <= n; k++) states[k][CENTER_SLOT + f] = (phi0 + turnsBefore(k, f)) & 3;
    }
    const mi = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) {
      let c = 0;
      for (const g of sg.groups) c += groupCost(g, states[k], INF);
      mi[k] = c;
      next[k] += c;
    }
    cost = next;
    back.push(from);
    mis.push(mi);
  }
  void end;
  // 終わり: 全部の手
  let k = n;
  const total = cost[n];
  const perSight: { t: number; k: number; mis: number }[] = [];
  for (let i = sights.length - 1; i >= 0; i--) {
    perSight.push({ t: sights[i].t0, k, mis: mis[i][k] });
    k = back[i][k];
    if (k < 0) break;
  }
  return { cost: total, perSight: perSight.reverse() };
}
