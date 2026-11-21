// 区間の動きを「行き先の表」で持ち、区間をまたいで絞る（伝搬版。solve.ts の区間の解き方の前に走らせ、候補の手順と仮説の見込みを渡す）。
//
// 未知数は区間ごとの手順ではなく、区間全体のピースの入れ替わり g（ピース 20 個の行き先と向き + センター 6 つの回した量）。
// g は「その区間の時間で回せる手数 K の、冗長でない手順のどれか」で、候補の集合 S を表の番号のビットの列で持つ（tables.ts）。
//   - 区間の式: 区間の前と後の見え方の両方で確かに読めたピースは g(x) = y。センターは「面 f を回した量 ≡ 向きの差（mod 4）」
//     → S = 式を（読み違い 1 本までなら外して）満たす手順。外すのは手 + 外した式の重み（ビット）が一番安いものから keep 以内だけ
//   - 区間をまたぐ式: 1 秒目と 3 秒目にだけ見えたピースは g₂(g₁(x)) = y。手順を並べず、ピースごとに「その見え方でどの位置に
//     いうるか」のコスト（位置 24 通り。センターは向き 4 通り）を前（A）と後ろ（B）から送る: 区間を越えるときは S の行き先の表
//     （位置 x から行ける y の集まり: M）を引くだけ。A・B が決まると、区間の各手順 g の下限のコスト（g の手 + ピースごとの
//     「g で動かしたときの、前後の読みとの食い違い」の和）が出るので、一番よい g から keep より悪い手順を S から除く。S が減ると M が
//     狭まり、A・B がさらに決まる。これを候補が減らなくなるまで繰り返す（前後どちらの向きにも）
//   - ピースごとに独立に動けるとみなした下限なので（同じ g がどのピースも動かすことは使わない）、本当の答えのコストより大きくならない。
//     長い式（3 区間以上をまたぐ）も同じ A・B で効く: 間の区間の S が十分減って M が狭まってから効く（組み合わせが掛け算で増えない）
//   - 「上位何個」では切らない。区間の S が大きすぎる（式が少ない）区間は列挙せず、ビットの列のまま行き先の表だけ作る
// 結果: 区間ごとの S（solve.ts が区間の解の候補を絞る）と、見え方ごとの「これからのコスト」B・「これまでのコスト」A（仮説の見込み:
// 前向きの仮説は B、後ろ向きの仮説は A を足した値で比べて落とす）。読み違いは式の重みのまま運ぶ（外す候補を選ぶのは伝搬の後: 仮説ごとに
// solve.ts の cheapPlans が選ぶ）。DOM もカメラも知らない
import type { Sight } from "./decode";
import { IS_CORNER, NUM_PIECES } from "./model";
import { type StrongSight } from "./solve";
import { IDX, MAX_TABLE_K, type SeqTable, inverseIndex, positionOf, seqTable, sequenceIndex } from "./tables";

export interface PropagateOptions {
  moveBits: number;
  // 区間の手数の上限 K = min(4, base + ⌊区間の長さ / perMs⌋)。区間の長さ = 前の見え方の始まりから次の見え方の終わりまで（見えない層の手は
  // 見え方の中でも回せる）。実物 5 本 × 4 画質の正解（buildTruth）で、見え方の間の手の数は 1 例（183ms に 6 手: 正解の状態の割り当ての
  // ずれ）を除いて 2 + ⌊長さ / 100ms⌋ 以下（tests/debug/propBench… の PB_KSPAN）。それより多い手は長い区間（5〜8 手、solve.ts の突き合わせ）
  kBase: number;
  kPerMs: number;
  keepBits: number; // 仮説の見込みで残す幅（solve.ts の keepBits と同じ）
  // 区間の手順の候補を、区間をまたぐ式（前後のコスト）で除く幅。手順 g の下限は、ほかの区間の手のコストを数えない（g を選ぶと別の区間で
  // 余分な手が要る、が見えない）ので、一番よい下限との差は本当のコストの差より小さく出ることがある。読み違いの式が 2 本重なっても
  // 本当の手順を落とさないよう、確かな式 3〜4 本ぶん（IMG_5048 の 5Mbps で、20 ビットでは本当の手順を除き、8 手多い別の手順を確定のまま選んだ）
  pruneBits: number;
  localBits: number; // 区間の式で S に残す幅（読み違い 1 本 ≈ 10〜13 ビットを外した手順まで）
  sparseMax: number; // S の手順がこれ以下なら列挙して下限で絞る（それより多い区間は行き先の表だけ）
  readCap: number; // 読み 1 本の食い違いのコストの上限（ビット）。仮説の見込みに使うので、読み違いの式を 1 本外すくらいに抑える
  centerBits: number; // センターの向きの読み 1 本の重み
  endBits: number; // 始まり・終わりの状態のピース 1 個の重み
  rounds: number; // 繰り返しの上限
  chains: boolean; // センター 1 つの面の読みも前後のコストに入れる
}

export const DEFAULT_PROPAGATE: PropagateOptions = {
  moveBits: Math.log2(13.35),
  kBase: 2,
  kPerMs: 100,
  keepBits: 20,
  pruneBits: 40,
  localBits: 19.5,
  sparseMax: 8192,
  readCap: 12,
  centerBits: 10,
  endBits: 40,
  rounds: 4,
  chains: true,
};

// 変数の並び: ピース p の位置（種類の中の番号 0〜23）= p * 24 + i、センター f の向き = CENTER0 + f * 4 + d
const CENTER0 = NUM_PIECES * 24;
export const VARS = CENTER0 + 24;
const BIG = 1e6;

// k' ≤ k 手で、種類 c の位置 x から行ける位置（ビット）: REACH[k][c * 24 + x]
let REACH: Uint32Array[] | null = null;
function reach(): Uint32Array[] {
  if (REACH) return REACH;
  const out: Uint32Array[] = [];
  let acc = new Uint32Array(48);
  for (let k = 0; k <= MAX_TABLE_K; k++) {
    const tb = seqTable(k);
    const r = acc.slice();
    for (let i = 0; i < tb.n; i++) for (let c = 0; c < 2; c++) for (let x = 0; x < 24; x++) r[c * 24 + x] |= 1 << tb.img[(i * 2 + c) * 24 + x];
    out.push(r);
    acc = r;
  }
  REACH = out;
  return out;
}

export interface IntervalSet {
  K: number; // 手数の上限（表の範囲: 4 まで）
  bits: Uint32Array[] | null; // k = 0..K の候補（null = 制限なし: K 手までの全部）
  count: number; // 候補の数
  local: number; // 区間の式で絞った候補の数
  free: boolean; // 区間の式がない（K 手までの全部）
  minLocal: number; // 区間の式のいちばん安いコスト（手 + 外した式）
}

export interface Propagation {
  sets: IntervalSet[]; // 区間 j（見え方 j の前。j = 見え方の数 は終わりの前）
  // 見え方 s（ノード s + 1）の、これからのコスト B と、これまでのコスト A（そのノードの読みを除く）。仮説の見込み
  ahead: Float32Array[]; // ノードごと（0 = 始まり、s + 1 = 見え方 s、n + 1 = 終わり）
  behind: Float32Array[];
  stats: PropagateStats;
}

export interface PropagateStats {
  intervals: number;
  sparse: number; // 列挙して下限で絞った区間
  crossNarrowed: number; // 区間をまたぐ式（前後のコスト）で候補が減った区間
  crossRemoved: number; // そのとき除いた手順の数
  rounds: number;
  free: number; // 区間の式のない区間
  inconsistent: number; // 区間の式を 2 本以上外さないと満たせない区間（制限しない）
  ms: number;
}

// ノードの読みのコスト（変数ごと）
function readingCosts(st: StrongSight | null, all: Uint8Array | null, opt: PropagateOptions): Float32Array {
  const c = new Float32Array(VARS);
  if (all) {
    // 始まり・終わりの状態（ピースは全部分かっている。センターの向きは分からない）
    for (let p = 0; p < NUM_PIECES; p++) {
      const y = IDX[all[p]];
      for (let i = 0; i < 24; i++) c[p * 24 + i] = i === y ? 0 : opt.endBits;
    }
    return c;
  }
  if (!st) return c;
  for (let p = 0; p < NUM_PIECES; p++) {
    if (st.to[p] < 0) continue;
    const y = IDX[st.to[p]];
    const w = Math.min(st.w[p], opt.readCap);
    for (let i = 0; i < 24; i++) c[p * 24 + i] = i === y ? 0 : w;
  }
  for (let f = 0; f < 6; f++) {
    if (st.center[f] < 0) continue;
    for (let d = 0; d < 4; d++) c[CENTER0 + f * 4 + d] = d === st.center[f] ? 0 : Math.min(opt.centerBits, opt.readCap);
  }
  // センター 1 つの面（置き方はその面のセンターの向き φ で決まる: solve.ts の chain）: ピースごとに「4 通りの φ のどれかの位置」なら 0。
  // どの φ でも読めたピースだけ（φ によって読めていないなら手がかりにならない）。φ がピースどうしで同じことは使わない（ピースごとに
  // 独立とみなした下限のまま）
  if (opt.chains)
    for (const ch of st.chain) {
      const seen = new Map<number, { ok: number; w: number; n: number }>();
      for (const v of ch.byPhi)
        for (let i = 0; i < v.P.length; i++) {
          const p = v.P[i];
          if (st.to[p] >= 0) continue;
          const o = seen.get(p) ?? { ok: 0, w: Number.POSITIVE_INFINITY, n: 0 };
          o.ok |= 1 << IDX[v.A[i]];
          o.w = Math.min(o.w, v.W[i]);
          o.n++;
          seen.set(p, o);
        }
      for (const [p, o] of seen) {
        if (o.n < ch.byPhi.length) continue;
        const w = Math.min(o.w, opt.readCap);
        for (let i = 0; i < 24; i++) c[p * 24 + i] = o.ok & (1 << i) ? 0 : Math.max(c[p * 24 + i], w);
      }
    }
  return c;
}

// 区間の式: 前のノードと後のノードの両方で読めた変数
interface LocalEq {
  cls: number; // 0 = コーナー・1 = エッジ・2 = センター
  x: number; // 位置の番号（センターは面）
  y: number; // 位置の番号（センターは回した量 0〜3）
  w: number;
}
function localEqs(a: Float32Array, b: Float32Array, pinA: Int8Array, pinB: Int8Array): LocalEq[] {
  const out: LocalEq[] = [];
  for (let p = 0; p < NUM_PIECES; p++) {
    const xa = pinA[p];
    const yb = pinB[p];
    if (xa < 0 || yb < 0) continue;
    // 外すコストは安い方の読み（どちらかが読み違い）
    const w = Math.min(maxOf(a, p * 24, 24), maxOf(b, p * 24, 24));
    out.push({ cls: PIECE_CLS[p], x: xa, y: yb, w });
  }
  for (let f = 0; f < 6; f++) {
    const xa = pinA[NUM_PIECES + f];
    const yb = pinB[NUM_PIECES + f];
    if (xa < 0 || yb < 0) continue;
    out.push({ cls: 2, x: f, y: (yb - xa + 4) & 3, w: Math.min(maxOf(a, CENTER0 + f * 4, 4), maxOf(b, CENTER0 + f * 4, 4)) });
  }
  return out;
}
const maxOf = (c: Float32Array, o: number, n: number) => {
  let m = 0;
  for (let i = 0; i < n; i++) if (c[o + i] > m) m = c[o + i];
  return m;
};
// ノードで読みが 1 つの値に決まっている変数（読みのコストが 0 の値がちょうど 1 つ）: 値の番号（-1 = 読みなし）
function pinsOf(c: Float32Array): Int8Array {
  const out = new Int8Array(NUM_PIECES + 6).fill(-1);
  for (let p = 0; p < NUM_PIECES + 6; p++) {
    const o = p < NUM_PIECES ? p * 24 : CENTER0 + (p - NUM_PIECES) * 4;
    const n = p < NUM_PIECES ? 24 : 4;
    let z = -1;
    let zeros = 0;
    let any = false;
    for (let i = 0; i < n; i++) {
      if (c[o + i] === 0) {
        zeros++;
        z = i;
      } else any = true;
    }
    if (any && zeros === 1) out[p] = z;
  }
  return out;
}

// ピース → 種類（0 = コーナー・1 = エッジ: tables.ts の CLS と同じ）
const PIECE_CLS = Int8Array.from(IS_CORNER, (c) => (c ? 0 : 1));

// 区間の式から S を作る（k = 0..K）。読み違いは 1 本まで外す（localBits 以内のものだけ）
function localSet(eqs: LocalEq[], K: number, opt: PropagateOptions): IntervalSet {
  if (!eqs.length) {
    // 区間の式がない: K 手までの全部。少なければ（K ≤ 3）列挙できるように集合で持つ（区間をまたぐ式で絞れる）
    const all = countAll(K);
    if (all > opt.sparseMax) return { K, bits: null, count: all, local: all, free: true, minLocal: 0 };
    const bits: Uint32Array[] = [];
    for (let k = 0; k <= K; k++) {
      const tb = seqTable(k);
      const b = new Uint32Array(tb.words);
      full(b, 0, tb);
      bits.push(b);
    }
    return { K, bits, count: all, local: all, free: true, minLocal: 0 };
  }
  const mb = opt.moveBits;
  let wmin = Number.POSITIVE_INFINITY;
  for (const e of eqs) wmin = Math.min(wmin, e.w);
  // k ごとに、手順ごとの満たさない式の本数をビットの列で数える（plane[j] = j + 1 本以上: solve.ts の cheapPlans と同じ数え上げ）
  const planes: Uint32Array[] = [];
  let lb = Number.POSITIVE_INFINITY; // コストの下限（本数 × いちばん軽い式）
  for (let k = 0; k <= K; k++) {
    const tb = seqTable(k);
    const W = tb.words;
    const g = new Uint32Array((PLANES + 1) * W);
    for (const e of eqs) {
      const src = rowOf(tb, e);
      for (let w = 0; w < W; w++) {
        const u = ~src.a[src.o + w];
        for (let j = PLANES; j > 0; j--) g[j * W + w] |= g[(j - 1) * W + w] & u;
        g[w] |= u;
      }
    }
    planes.push(g);
    for (let v = 0; v <= PLANES && k * mb + v * wmin < lb; v++) if (nonEmpty(exactly(g, v, tb))) lb = Math.min(lb, k * mb + v * wmin);
  }
  // 区間の式が 3 本以上食い違う（回している途中のフレームの読み違いが重なった・見失った）: 区間の式では絞らない
  if (!Number.isFinite(lb)) return { K, bits: null, count: countAll(K), local: countAll(K), free: false, minLocal: Number.POSITIVE_INFINITY };
  // 下限から localBits 以内になりうる手順だけ、外した式の重みを数える
  const found: { k: number; i: number; c: number }[] = [];
  const exact0: Uint32Array[] = [];
  let min = Number.POSITIVE_INFINITY;
  let minK = 0;
  for (let k = 0; k <= K; k++) {
    const tb = seqTable(k);
    const g = planes[k];
    const e0 = k * mb <= lb + opt.localBits ? exactly(g, 0, tb) : new Uint32Array(tb.words);
    exact0.push(e0);
    if (nonEmpty(e0) && k * mb < min) {
      min = k * mb;
      minK = k;
    }
    const vmax = Math.min(PLANES, Math.floor((lb + opt.localBits - k * mb) / wmin));
    for (let v = 1; v <= vmax; v++)
      forEachBit(exactly(g, v, tb), (i) => {
        let c = k * mb;
        for (const e of eqs) {
          const ok = e.cls === 2 ? tb.amount[i * 6 + e.x] === e.y : tb.img[(i * 2 + e.cls) * 24 + e.x] === e.y;
          if (!ok) c += e.w;
        }
        found.push({ k, i, c });
        if (c < min) {
          min = c;
          minK = k;
        }
      });
  }
  // いちばん安い手順でも 3 本以上外す区間は信用しない
  if (min - minK * mb >= 2.5 * wmin) {
    const all = countAll(K);
    return { K, bits: null, count: all, local: all, free: false, minLocal: min };
  }
  const bits: Uint32Array[] = [];
  let count = 0;
  for (let k = 0; k <= K; k++) bits.push(k * mb <= min + opt.localBits ? exact0[k] : new Uint32Array(seqTable(k).words));
  for (const f of found) if (f.c <= min + opt.localBits) bits[f.k][f.i >>> 5] |= 1 << (f.i & 31);
  for (const b of bits) count += popcount(b);
  return { K, bits, count, local: count, free: false, minLocal: min };
}

// 満たさない式の本数の数え上げの段の数（これより多く外す手順は候補にしない）
const PLANES = 4;
// 満たさない式がちょうど v 本の手順（表の範囲の外のビットは消す）
function exactly(g: Uint32Array, v: number, tb: SeqTable): Uint32Array {
  const W = tb.words;
  const out = new Uint32Array(W);
  for (let w = 0; w < W; w++) out[w] = (v === 0 ? ~g[w] : g[(v - 1) * W + w] & ~g[v * W + w]) >>> 0;
  const tail = tb.n & 31;
  if (tail) out[W - 1] &= (1 << tail) - 1;
  return out;
}


const rowOf = (tb: SeqTable, e: LocalEq): { a: Uint32Array; o: number } =>
  e.cls === 2 ? { a: tb.C, o: (e.x * 4 + e.y) * tb.words } : { a: tb.T, o: ((e.cls * 24 + e.x) * 24 + e.y) * tb.words };
function full(b: Uint32Array, o: number, tb: SeqTable): void {
  b.fill(0xffffffff, o, o + tb.words);
  const tail = tb.n & 31;
  if (tail) b[o + tb.words - 1] = (1 << tail) - 1;
}
const nonEmpty = (b: Uint32Array) => {
  for (let w = 0; w < b.length; w++) if (b[w]) return true;
  return false;
};
export function popcount(b: Uint32Array): number {
  let n = 0;
  for (let w = 0; w < b.length; w++) {
    let x = b[w];
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    n += (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return n;
}
function countAll(K: number): number {
  let n = 0;
  for (let k = 0; k <= K; k++) n += seqTable(k).n;
  return n;
}

// 区間の行き先の表 M: 種類 c の位置 x から行ける位置（ビット）と、面 f の回した量（4 ビット）
export interface Moves {
  pos: Uint32Array; // [c * 24 + x]
  amt: Uint8Array; // [f]
}
export function movesOf(set: IntervalSet): Moves {
  const R = reach();
  const amt = new Uint8Array(6);
  if (!set.bits) {
    for (let f = 0; f < 6; f++) amt[f] = set.K >= 1 ? 15 : 1;
    return { pos: R[set.K].slice(), amt };
  }
  const pos = new Uint32Array(48);
  for (let k = 0; k <= set.K; k++) {
    const tb = seqTable(k);
    const b = set.bits[k];
    const W = tb.words;
    if (popcount(b) * 48 <= 48 * 24 * 4) {
      // 少なければ手順ごとに
      forEachBit(b, (i) => {
        for (let c = 0; c < 2; c++) for (let x = 0; x < 24; x++) pos[c * 24 + x] |= 1 << tb.img[(i * 2 + c) * 24 + x];
        for (let f = 0; f < 6; f++) amt[f] |= 1 << tb.amount[i * 6 + f];
      });
      continue;
    }
    for (let c = 0; c < 2; c++)
      for (let x = 0; x < 24; x++) {
        let cand = R[k][c * 24 + x] & ~pos[c * 24 + x];
        while (cand) {
          const y = 31 - Math.clz32(cand & -cand);
          cand &= cand - 1;
          const o = ((c * 24 + x) * 24 + y) * W;
          for (let w = 0; w < W; w++)
            if (tb.T[o + w] & b[w]) {
              pos[c * 24 + x] |= 1 << y;
              break;
            }
        }
      }
    for (let f = 0; f < 6; f++)
      for (let d = 0; d < 4; d++) {
        if (amt[f] & (1 << d)) continue;
        const o = (f * 4 + d) * W;
        for (let w = 0; w < W; w++)
          if (tb.C[o + w] & b[w]) {
            amt[f] |= 1 << d;
            break;
          }
      }
  }
  return { pos, amt };
}
function forEachBit(b: Uint32Array, f: (i: number) => void): void {
  for (let w = 0; w < b.length; w++) {
    let x = b[w];
    while (x) {
      const bit = 31 - Math.clz32(x & -x);
      x &= x - 1;
      f(w * 32 + bit);
    }
  }
}

// 2 つの区間を続けたときの行き先の表: x から a で y、y から b で z（ピースごとに独立: 手順の組を並べずに区間をまたぐ式を運ぶ）。
// センターの回した量は足し算（mod 4）
export function composeMoves(a: Moves, b: Moves): Moves {
  const pos = new Uint32Array(48);
  for (let c = 0; c < 2; c++)
    for (let x = 0; x < 24; x++) {
      let ys = a.pos[c * 24 + x];
      while (ys) {
        const y = 31 - Math.clz32(ys & -ys);
        ys &= ys - 1;
        pos[c * 24 + x] |= b.pos[c * 24 + y];
      }
    }
  const amt = new Uint8Array(6);
  for (let f = 0; f < 6; f++) for (let d = 0; d < 4; d++) for (let e = 0; e < 4; e++) if (a.amt[f] & (1 << d) && b.amt[f] & (1 << e)) amt[f] |= 1 << ((d + e) & 3);
  return { pos, amt };
}

// 手順の並びから区間の候補を作る（テスト・調査用）
export function setOfSequences(K: number, seqs: readonly (readonly number[])[]): IntervalSet {
  const bits: Uint32Array[] = [];
  for (let k = 0; k <= K; k++) bits.push(new Uint32Array(seqTable(k).words));
  let count = 0;
  for (const q of seqs) {
    const i = sequenceIndex(q);
    if (i < 0 || q.length > K) throw new Error("表にない手順");
    if (!(bits[q.length][i >>> 5] & (1 << (i & 31)))) count++;
    bits[q.length][i >>> 5] |= 1 << (i & 31);
  }
  return { K, bits, count, local: count, free: false, minLocal: 0 };
}

// 前へ: next(y) = min_{x → y} prev(x)（ピースごと、センターは回した量で）
function stepForward(prev: Float32Array, M: Moves, out: Float32Array): void {
  out.fill(BIG);
  for (let p = 0; p < NUM_PIECES; p++) {
    const c = PIECE_CLS[p];
    const o = p * 24;
    for (let x = 0; x < 24; x++) {
      const v = prev[o + x];
      if (v >= BIG) continue;
      let ys = M.pos[c * 24 + x];
      while (ys) {
        const y = 31 - Math.clz32(ys & -ys);
        ys &= ys - 1;
        if (v < out[o + y]) out[o + y] = v;
      }
    }
  }
  for (let f = 0; f < 6; f++) {
    const o = CENTER0 + f * 4;
    for (let x = 0; x < 4; x++) {
      const v = prev[o + x];
      if (v >= BIG) continue;
      for (let d = 0; d < 4; d++) if (M.amt[f] & (1 << d) && v < out[o + ((x + d) & 3)]) out[o + ((x + d) & 3)] = v;
    }
  }
}
// 後ろへ: prev(x) = min_{x → y} next(y)
function stepBackward(next: Float32Array, M: Moves, out: Float32Array): void {
  out.fill(BIG);
  for (let p = 0; p < NUM_PIECES; p++) {
    const c = PIECE_CLS[p];
    const o = p * 24;
    for (let x = 0; x < 24; x++) {
      let ys = M.pos[c * 24 + x];
      let best = BIG;
      while (ys) {
        const y = 31 - Math.clz32(ys & -ys);
        ys &= ys - 1;
        if (next[o + y] < best) best = next[o + y];
      }
      out[o + x] = best;
    }
  }
  for (let f = 0; f < 6; f++) {
    const o = CENTER0 + f * 4;
    for (let x = 0; x < 4; x++) {
      let best = BIG;
      for (let d = 0; d < 4; d++) if (M.amt[f] & (1 << d) && next[o + ((x + d) & 3)] < best) best = next[o + ((x + d) & 3)];
      out[o + x] = best;
    }
  }
}

// 区間 j の候補 S を、前のノードまでのコスト Ain（読みを含む）と後のノードからのコスト Bout（後のノードの読みを含む）で絞る。
// 手順 g の下限 = g の手 + Σ_ピース min_x [Ain(x) + Bout(g(x))]。ピースの前のコストが 1 つの位置に集まっていれば（2 番目との差が Bout の幅より
// 大きい）その位置だけ、候補の位置が少なければ（6 つまで）全部を見る。それより多いピースは g によらない下限（定数）にする
function pruneSet(set: IntervalSet, Ain: Float32Array, Bout: Float32Array, opt: PropagateOptions): number {
  if (!set.bits || set.count > opt.sparseMax) return 0;
  // ピースごとに見る位置
  const look: { o: number; c: number; xs: number[]; base: Float32Array; isCenter: boolean; f: number }[] = [];
  const tmp: number[] = [];
  for (let p = 0; p < NUM_PIECES + 6; p++) {
    const isC = p >= NUM_PIECES;
    const o = isC ? CENTER0 + (p - NUM_PIECES) * 4 : p * 24;
    const n = isC ? 4 : 24;
    let bmin = BIG;
    let bmax = 0;
    for (let i = 0; i < n; i++) {
      bmin = Math.min(bmin, Bout[o + i]);
      bmax = Math.max(bmax, Bout[o + i]);
    }
    if (bmax - bmin < 0.5) continue; // 後ろが g によらない
    let amin = BIG;
    for (let i = 0; i < n; i++) amin = Math.min(amin, Ain[o + i]);
    tmp.length = 0;
    for (let i = 0; i < n; i++) if (Ain[o + i] < amin + (bmax - bmin)) tmp.push(i);
    if (tmp.length > 6) continue;
    look.push({ o, c: isC ? 2 : PIECE_CLS[p], xs: [...tmp], base: Ain, isCenter: isC, f: isC ? p - NUM_PIECES : -1 });
  }
  if (!look.length) return 0;
  const lbs: { k: number; i: number; lb: number }[] = [];
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k <= set.K; k++) {
    const tb = seqTable(k);
    forEachBit(set.bits[k], (i) => {
      let lb = k * opt.moveBits;
      for (const L of look) {
        let m = BIG;
        for (const x of L.xs) {
          const y = L.isCenter ? (x + tb.amount[i * 6 + L.f]) & 3 : tb.img[(i * 2 + L.c) * 24 + x];
          const v = L.base[L.o + x] + Bout[L.o + y];
          if (v < m) m = v;
        }
        lb += m;
      }
      lbs.push({ k, i, lb });
      if (lb < best) best = lb;
    });
  }
  let removed = 0;
  for (const x of lbs)
    if (x.lb > best + opt.pruneBits) {
      set.bits[x.k][x.i >>> 5] &= ~(1 << (x.i & 31));
      removed++;
    }
  set.count -= removed;
  return removed;
}

export function propagate(sights: Sight[], strong: StrongSight[], start: Uint8Array, end: Uint8Array, options: Partial<PropagateOptions> = {}): Propagation {
  const t0 = performance.now();
  const opt = { ...DEFAULT_PROPAGATE, ...options };
  const n = sights.length;
  const N = n + 2;
  const stats: PropagateStats = { intervals: n + 1, sparse: 0, crossNarrowed: 0, crossRemoved: 0, rounds: 0, free: 0, inconsistent: 0, ms: 0 };
  // ノードの読みのコスト
  const C: Float32Array[] = [];
  C.push(readingCosts(null, start, opt));
  for (let s = 0; s < n; s++) C.push(readingCosts(strong[s], null, opt));
  C.push(readingCosts(null, end, opt));
  const pins = C.map(pinsOf);
  // 区間 j: ノード j → j + 1。手数の上限は前の見え方の始まりから次の見え方の終わりまでの長さから
  const sets: IntervalSet[] = [];
  for (let j = 0; j <= n; j++) {
    const a = j > 0 ? sights[j - 1].t0 : Number.NaN;
    const b = j < n ? sights[j].t1 : Number.NaN;
    const span = Number.isFinite(a) && Number.isFinite(b) ? b - a : Number.POSITIVE_INFINITY;
    const K = Math.min(MAX_TABLE_K, opt.kBase + Math.floor(span / opt.kPerMs));
    const set = localSet(localEqs(C[j], C[j + 1], pins[j], pins[j + 1]), K, opt);
    if (set.free) stats.free++;
    if (!set.free && !set.bits) stats.inconsistent++;
    if (set.bits && set.count <= opt.sparseMax) stats.sparse++;
    sets.push(set);
  }
  // 前後のコスト。A[j] = ノード j までの読みのコスト（j を含む）、B[j] = ノード j より後の読みのコスト（j を含まない）
  const A = Array.from({ length: N }, () => new Float32Array(VARS));
  const B = Array.from({ length: N }, () => new Float32Array(VARS));
  const tmp = new Float32Array(VARS);
  const narrowed = new Set<number>();
  let M = sets.map(movesOf);
  for (let round = 0; round < opt.rounds; round++) {
    stats.rounds = round + 1;
    A[0].set(C[0]);
    for (let j = 1; j < N; j++) {
      stepForward(A[j - 1], M[j - 1], tmp);
      for (let v = 0; v < VARS; v++) A[j][v] = tmp[v] + C[j][v];
    }
    B[N - 1].fill(0);
    for (let j = N - 2; j >= 0; j--) {
      for (let v = 0; v < VARS; v++) tmp[v] = C[j + 1][v] + B[j + 1][v];
      stepBackward(tmp, M[j], B[j]);
    }
    // 絞る（後のノードの読み + その先のコスト）
    let changed = 0;
    const bout = new Float32Array(VARS);
    for (let j = 0; j <= n; j++) {
      for (let v = 0; v < VARS; v++) bout[v] = C[j + 1][v] + B[j + 1][v];
      const r = pruneSet(sets[j], A[j], bout, opt);
      if (r) {
        changed++;
        stats.crossRemoved += r;
        narrowed.add(j);
        M[j] = movesOf(sets[j]);
      }
    }
    if (!changed) break;
  }
  stats.crossNarrowed = narrowed.size;
  // 仮説の見込み: 前向きの仮説（ノード j、読みはコストに入っている）は B[j]、後ろ向きの仮説は A[j] − C[j]（そのノードの読みを除く）。
  // ピースごとに一番安い値を 0 に
  const ahead = B.map((b) => normalize(b));
  const behind = A.map((a, j) => {
    const x = new Float32Array(VARS);
    for (let v = 0; v < VARS; v++) x[v] = a[v] - C[j][v];
    return normalize(x);
  });
  stats.ms = performance.now() - t0;
  void M;
  return { sets, ahead, behind, stats };
}

function normalize(x: Float32Array): Float32Array {
  for (let p = 0; p < NUM_PIECES + 6; p++) {
    const o = p < NUM_PIECES ? p * 24 : CENTER0 + (p - NUM_PIECES) * 4;
    const n = p < NUM_PIECES ? 24 : 4;
    let m = BIG;
    for (let i = 0; i < n; i++) m = Math.min(m, x[o + i]);
    for (let i = 0; i < n; i++) x[o + i] = Math.min(x[o + i] - m, BIG);
  }
  return x;
}

// 仮説の状態 s（ピースの位置は facelet・センターの向き 0〜3 / 4 = 分からない）の見込み（ビット）
export function hopeOf(h: Float32Array, s: Uint8Array): number {
  let v = 0;
  for (let p = 0; p < NUM_PIECES; p++) v += h[p * 24 + IDX[s[p]]];
  for (let f = 0; f < 6; f++) {
    const d = s[NUM_PIECES + f];
    if (d < 4) v += h[CENTER0 + f * 4 + d];
  }
  return v;
}

// 区間 j の手順 i（k 手）が候補に入っているか
export function allowed(set: IntervalSet | undefined, k: number, i: number): boolean {
  if (!set) return true;
  if (k > set.K) return k > MAX_TABLE_K; // 表の範囲より長い手順（突き合わせ）は制限しない
  if (!set.bits) return true;
  return (set.bits[k][i >>> 5] & (1 << (i & 31))) !== 0;
}

// solve.ts の runSteps の見え方 step（back なら後ろ向き）の前の区間の候補（k = 0..4 のビットの列。null = 制限なし）と仮説の見込み。
// 後ろ向きは時間を逆にたどる（区間 n − step、手順は逆の手を逆の順に: 番号を引き直す。候補が多すぎる区間は制限しない）
export interface StepHints {
  masks: (Uint32Array | null)[][];
  hope: (Float32Array | null)[];
}
export function stepHints(prop: Propagation, n: number, back: boolean, remapMax = 20000, use: { masks: boolean; hope: boolean } = { masks: true, hope: true }): StepHints {
  const masks: (Uint32Array | null)[][] = [];
  const hope: (Float32Array | null)[] = [];
  for (let step = 0; step <= n; step++) {
    const j = back ? n - step : step;
    const set = prop.sets[j];
    const m: (Uint32Array | null)[] = [];
    for (let k = 0; k <= MAX_TABLE_K; k++) {
      const tb = seqTable(k);
      if (!use.masks) m.push(null);
      else if (k > set.K) m.push(new Uint32Array(tb.words));
      else if (!set.bits) m.push(null);
      else if (!back) m.push(set.bits[k]);
      else if (set.count > remapMax) m.push(null);
      else {
        const inv = inverseIndex(k);
        const b = new Uint32Array(tb.words);
        forEachBit(set.bits[k], (i) => {
          const r = inv[i];
          b[r >>> 5] |= 1 << (r & 31);
        });
        m.push(b);
      }
    }
    masks.push(m);
    // 見え方 step の後の仮説: 前向きはノード step + 1（終わりはノード n + 1）のこれから、後ろ向きはノード n − step（始まりは 0）のこれまで
    hope.push(!use.hope ? null : back ? (step < n ? prop.behind[n - step] : null) : step < n ? prop.ahead[step + 1] : null);
  }
  return { masks, hope };
}

export { positionOf };
