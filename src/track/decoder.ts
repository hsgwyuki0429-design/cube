// 手順デコーダ（ビームサーチ）。
//
// 仮説 = (キューブ状態, キューブの姿勢)。安定した観測が来るたびに、各仮説を 0〜maxMovesPerStep 手だけ
// 展開し、姿勢の変化（持ち替え）も候補に入れる。観測と矛盾するステッカーごとにコストを払い、
// 安いものだけ beamWidth 個残す。見えない面の回転（カメラの反対側など）は、その影響が
// 見える面に現れた時点で遡って推定される。
//
// 映像から直接手順を組み立てるのではなく、「候補手を状態機械で適用し、予測される見え方と照合する」。
//
// 高速回転（〜10TPS）では観測の間に3〜4手進むことがあるので、展開は深さ優先ではなく
// 「どんな子孫もこれ以上安くならない」下限（現在のコスト + 手数）でビームの外を刈り込みながら深くする。
//
// 参考: AllefDouglasDev/rubik-cube (MIT) の app/src/tracking/decoder.ts のビームサーチを基に、
// 姿勢（24通り）を仮説に含め、ソフトな色コスト・下限による刈り込み・見失い検出と復帰を加えたもの。
import { hashState } from "../cube/hash";
import { MOVE_SRC, NUM_MOVES, NUM_ORIENTATIONS, VIEW, type CubeState, cubeFaceAt, moveFace, redundantAfter, statesEqual } from "../cube/model";
import { stickerIdAt, stickerIds } from "../cube/stickers";
import { type MovePrior, EMPTY_CONTEXT, movePrior, shiftContext } from "./prior";
import type { DecodedMove, Observation, TrackStatus } from "./types";

export interface DecoderOptions {
  beamWidth: number;
  maxMovesPerStep: number;
  moveCost: number;
  rotationCost: number;
  // 最良仮説からこのコスト差以内の仮説が全て一致している手だけを「確定」にする
  confirmMargin: number;
  // 最良仮説でもこの観測コストを超えたら「不確か」
  uncertainCost: number;
  // 「不確か」がこの回数続いたら見失い（復帰探索を試みる）
  lostAfter: number;
  recoveryDepth: number;
  // 2 手までで観測がこれ以下のコストで説明できたら、それ以上深く探さない（速さのため。説明できないときだけ深く）
  deepenAbove: number;
  // 手順の知識（prior.ts）の効き具合。直前の数手に続く手が知っている手順の並びでなければ、その手のコストを上乗せする（0 で使わない）
  priorWeight: number;
  // 回転途中の形で見えた層の回転（Observation.turns）と合わない手の並びのコスト: 回した量が合わない / その軸の手がない
  turnCost: number;
  turnAxisCost: number;
  // 3 手以上を探す仮説の数（コストの安い方から）。ライブは 4（controller.liveEngineOptions。処理の遅い端末で間が開くと観測の 3 割ほどで
  // 3 手まで探し、32 仮説すべてを深くして 1 観測 20 万候補・デコーダが 1 フレームの半分を使っていた。実物の動画で一致は同じ・1 観測の評価 6.8 → 2.4 万）
  deepHyps: number;
  // 読んだステッカーの ID から出る下限で、手順の木の節点を評価せずに捨てる（下の「読んだステッカーの ID による枝刈り」。結果は同じで
  // 速い。false は確かめ用: tests/decoder.test.ts）
  idPrune: boolean;
  // 読んだステッカーを手がかりに、maxMovesPerStep より深くこの手数まで探す（0 で探さない。下の「深く探す」）
  bridgeDepth: number;
}

export const DEFAULT_DECODER: DecoderOptions = {
  beamWidth: 32,
  maxMovesPerStep: 3,
  moveCost: 1,
  rotationCost: 1.5,
  confirmMargin: 2.5,
  uncertainCost: 3.2,
  lostAfter: 3,
  recoveryDepth: 4,
  deepenAbove: 0.75,
  priorWeight: 1,
  turnCost: 0.6,
  turnAxisCost: 0.4,
  deepHyps: Infinity,
  idPrune: true,
  bridgeDepth: 0,
};

interface MoveNode {
  move: number;
  t0: number;
  t: number;
  orient: number;
  inferred: boolean;
  prev: MoveNode | null;
  len: number;
}

export interface Hypothesis {
  state: CubeState;
  orient: number;
  cost: number;
  obsCost: number; // 直近の観測での矛盾コスト
  tail: MoveNode | null;
  // ライブの作り変えで足した仮説（とその子孫）: 何回目か・そのときの手の数・作り変えた状態。手順は作り変えの前後でつながらない
  origin?: HypothesisOrigin | null;
}

export interface HypothesisOrigin {
  n: number;
  at: number;
  state: number[];
  t: number;
}

// 状態 + 姿勢の 53bit ハッシュ（衝突確率は無視できる）
const combineKey = (h: [number, number], o: number) => (h[0] & 0x1fffff) * 0x100000000 + (((h[1] ^ Math.imul(o + 1, 0x9e3779b1)) >>> 0));

// 展開する手順の木（深さごとに並べ、親の状態から1手だけ進めて子の状態を作る）。
// 同じ面の連続（R R）と、反対面の並べ替え（L R と R L）は同じ状態になるので片方だけ作る。
interface SeqTree {
  move: Int8Array; // 最後の手
  parent: Int32Array; // 1手短い親の番号（深さ0は -1）
  levelStart: number[]; // levelStart[d] .. levelStart[d+1]-1 が深さ d
  firstChild: Int32Array; // 子を持つ節点 p の子は firstChild[p] .. firstChild[p+1]-1（親の順に続けて並んでいる）
}
const treeCache = new Map<number, SeqTree>();
function sequenceTree(depth: number): SeqTree {
  let t = treeCache.get(depth);
  if (t) return t;
  const move: number[] = [-1];
  const parent: number[] = [-1];
  const levelStart = [0, 1];
  const firstChild: number[] = [];
  for (let d = 1; d <= depth; d++) {
    const from = levelStart[d - 1];
    const to = levelStart[d];
    for (let p = from; p < to; p++) {
      const last = move[p];
      firstChild.push(move.length);
      for (let m = 0; m < NUM_MOVES; m++) {
        if (redundantAfter(last, m)) continue;
        move.push(m);
        parent.push(p);
      }
    }
    levelStart.push(move.length);
  }
  firstChild.push(move.length);
  t = { move: Int8Array.from(move), parent: Int32Array.from(parent), levelStart, firstChild: Int32Array.from(firstChild) };
  treeCache.set(depth, t);
  return t;
}

// 手順の木の節点ごとの状態の入れ物（1 本の領域を 54 バイトずつに分けたもの）。木ごとに 1 つ作って使い回す: 観測のたびに節点の数だけ
// 配列を作っていた間は、深さ 4 で 1 回 7MB、見失ったときの深さ 5 では 1 回 100MB 近くになり、iPhone では解析の途中で落ちる元になった。
// expand は入れ子に呼ばれず、残す仮説の状態は作り直すので、使い回してよい
const bufferCache = new WeakMap<SeqTree, Uint8Array[]>();
function stateBuffers(tree: SeqTree): Uint8Array[] {
  let b = bufferCache.get(tree);
  if (!b) {
    const n = tree.move.length;
    const all = new Uint8Array(n * 54);
    b = new Array(n);
    for (let i = 0; i < n; i++) b[i] = all.subarray(i * 54, i * 54 + 54);
    stampCache.set(b, new Uint32Array(n));
    // 深さ 4（4.8 万節点・入れ物 3MB ほど）までは覚えておく。それより大きい木は使うときだけ（覚えると居座る）
    if (n <= 60000) bufferCache.set(tree, b);
  }
  return b;
}

// 手順の木の各節点までの、軸（x・y・z = 0・1・2）ごとの層の回転: 軸の正の側の層を負の側に対して、軸の正の向きのまわりに
// 右手で 90° 単位（0〜3）と、その軸の手があるか。正の側の面の手（時計回り = 法線のまわりに -90°）も負の側の面の手（法線は軸の
// 負の向き）も、正の側の層から見た回転は「-(回した量)」になる
interface TreeTurns {
  net: Int8Array; // node * 3 + axis
  has: Uint8Array;
}
const turnCache = new Map<SeqTree, TreeTurns>();
const AXIS_OF_FACE = [1, 0, 2, 1, 0, 2]; // U R F D L B の法線の軸
function treeTurns(tree: SeqTree): TreeTurns {
  let t = turnCache.get(tree);
  if (t) return t;
  const n = tree.move.length;
  const net = new Int8Array(n * 3);
  const has = new Uint8Array(n * 3);
  for (let node = 1; node < n; node++) {
    const p = tree.parent[node];
    for (let a = 0; a < 3; a++) {
      net[node * 3 + a] = net[p * 3 + a];
      has[node * 3 + a] = has[p * 3 + a];
    }
    const m = tree.move[node];
    const a = AXIS_OF_FACE[moveFace(m)];
    const k = (m % 3) + 1; // 1 = 時計回り・2 = 半回転・3 = 反時計回り
    net[node * 3 + a] = (net[node * 3 + a] + 4 - k) % 4;
    has[node * 3 + a] = 1;
  }
  t = { net, has };
  turnCache.set(tree, t);
  return t;
}

// 見えた回転（90° 単位）と手の並びの回転が合うか。半回転は途中で 90° の形を通る（立方体の形に見えて、そこで見えている回転が
// 途切れることがある）ので、90° が見えたら同じ向きの 90° か半回転なら合うとする（向きの違う 90° は合わない）
export function turnConsistent(seen: number, net: number): boolean {
  if (seen === 1 || seen === 3) return net === seen || net === 2;
  return net === seen;
}

// ---- 読んだステッカーの ID による枝刈り ----
// マスごとに違うステッカー（ArUco unique54）が読めた観測では、「このマスにはこのステッカーがある」と分かっている。手順の木の節点 p の
// 子（p にもう 1 手 m）それぞれについて、その手で合うようになる・合ったままの読みを数えれば、子の状態を作らずに観測のコストの下限が出る
// （合わない読みは、色の矛盾かステッカーの矛盾のどちらかを必ず払う）。下限がしきい値を超える子は評価しない。捨てるのはどのみち
// しきい値を超える候補だけなので、結果は変わらない。手順の木の最後の段（節点の 9 割）のほとんどが状態を作らずに済む
// MOVE_DST[m][a]: facelet a にあるステッカーが手 m で移る先
const MOVE_DST: Uint8Array[] = MOVE_SRC.map((src) => {
  const d = new Uint8Array(54);
  for (let i = 0; i < 54; i++) d[src[i]] = i;
  return d;
});
// REACH1[a * 54 + b]: a にあるステッカーを 1 手で b に置く手のビット（a === b なら、そのステッカーを動かさない手）
const REACH1 = (() => {
  const t = new Int32Array(54 * 54);
  for (let a = 0; a < 54; a++) for (let m = 0; m < NUM_MOVES; m++) t[a * 54 + MOVE_DST[m][a]] |= 1 << m;
  return t;
})();
// 深く探すとき用: NOT_FIRST[j - 1][a * 54 + b] = a にあるステッカーを j 手以内で b に置く手順の「最初の手」になれない手のビット
// （j = 1〜4。どのステッカーも同じ種類の場所へ 3 手以内で届くので、5 手以上は 4 手と同じ）。ステッカー 1 枚ずつで見た条件なので、
// 「読んだステッカーをすべて合わせる手順」の最初の手はこれより少ない（下限として使う）
const NOT_FIRST: Int32Array[] = (() => {
  const all = (1 << NUM_MOVES) - 1;
  let reach = new Uint8Array(54 * 54); // j - 1 手以内で届くか
  for (let a = 0; a < 54; a++) reach[a * 54 + a] = 1;
  const out: Int32Array[] = [];
  for (let j = 1; j <= 4; j++) {
    const first = new Int32Array(54 * 54);
    const next = new Uint8Array(54 * 54);
    for (let a = 0; a < 54; a++)
      for (let b = 0; b < 54; b++) {
        let mask = 0;
        for (let m = 0; m < NUM_MOVES; m++) if (reach[MOVE_DST[m][a] * 54 + b]) mask |= 1 << m;
        first[a * 54 + b] = all & ~mask;
        next[a * 54 + b] = mask ? 1 : 0;
      }
    out.push(first);
    reach = next;
  }
  return out;
})();
const BRIDGE_MIN_IDS = 8; // 深く探すのに要る、読めたステッカーの数（少ないと、たまたま合う手順がいくつもある）
const BRIDGE_MAX_OBS = 1; // 深く探して見つけた手順に許す、読んだステッカーの矛盾（1 枚の矛盾より小さい = 読めたステッカーは全部合うこと）
// DISTURB[f * 3 + k]: facelet f のステッカーを動かす面（3 つまで。なければ -1）。センターはどの手でも動かない
const DISTURB = (() => {
  const t = new Int8Array(54 * 3).fill(-1);
  for (let f = 0; f < 54; f++) {
    let k = 0;
    for (let face = 0; face < 6; face++) if (MOVE_DST[face * 3][f] !== f) t[f * 3 + k++] = face;
  }
  return t;
})();
// 手順の木の節点（最後の段を除く）ごとの、始まりの facelet g にあったステッカーのいまの位置: perms[node * 54 + g]。仮説によらない
const permCache = new WeakMap<SeqTree, Uint8Array>();
function treePerms(tree: SeqTree): Uint8Array {
  let t = permCache.get(tree);
  if (t) return t;
  const n = tree.levelStart[tree.levelStart.length - 2]; // 最後の段の始まり = 子を持つ節点の数
  t = new Uint8Array(n * 54);
  for (let g = 0; g < 54; g++) t[g] = g;
  for (let node = 1; node < n; node++) {
    const d = MOVE_DST[tree.move[node]];
    const p = tree.parent[node] * 54;
    for (let g = 0; g < 54; g++) t[node * 54 + g] = d[t[p + g]];
  }
  permCache.set(tree, t);
  return t;
}
// 節点の状態をいつ作ったか（仮説ごとに番号を変える。作っていない節点は親からたどって作る）
const stampCache = new WeakMap<Uint8Array[], Uint32Array>();
let stampEpoch = 0;

// 観測の読んだステッカー（姿勢 o で見たとき）: あるはずの facelet・ステッカー・合わないときに必ず払うコスト
interface IdConstraints {
  n: number;
  f: Uint8Array;
  id: Int16Array;
  lb: Float64Array;
  total: number;
}
const NO_CONSTRAINTS: IdConstraints = { n: 0, f: new Uint8Array(0), id: new Int16Array(0), lb: new Float64Array(0), total: 0 };
function idConstraints(obs: Observation, o: number): IdConstraints {
  const f: number[] = [];
  const id: number[] = [];
  const lb: number[] = [];
  for (const face of obs.faces) {
    if (!face.ids || !face.idCost || face.alts?.length) continue;
    for (let cell = 0; cell < 9; cell++) {
      const x = face.ids[cell];
      const label = face.labels[cell];
      if (x < 0 || label < 0) continue;
      let min: number = face.idCost[cell];
      for (let c = 0; c < 6; c++) if (c !== label && face.cost[cell * 6 + c] < min) min = face.cost[cell * 6 + c];
      if (!(min > 0)) continue;
      f.push(VIEW[(o * 6 + face.slot) * 9 + cell]);
      id.push(x);
      lb.push(min);
    }
  }
  return { n: f.length, f: Uint8Array.from(f), id: Int16Array.from(id), lb: Float64Array.from(lb), total: lb.reduce((a, b) => a + b, 0) };
}

function seqOf(tree: SeqTree, node: number): number[] {
  const out: number[] = [];
  for (let n = node; n > 0; n = tree.parent[n]) out.push(tree.move[n]);
  return out.reverse();
}

function toList(tail: MoveNode | null): DecodedMove[] {
  const out: DecodedMove[] = [];
  for (let n = tail; n; n = n.prev) out.push({ move: n.move, t0: n.t0, t: n.t, orient: n.orient, ...(n.inferred ? { inferred: true } : {}) });
  return out.reverse();
}

// 観測のうち、姿勢 o で見たときに参照する facelet と cost のペアを平坦化
interface CompiledObs {
  idx: Int32Array; // facelet 番号
  costBase: Int32Array; // cost 配列内のオフセット（cell*6）
  costs: Float32Array[]; // face ごと
  faceOf: Int32Array;
  alts: (Float32Array[] | undefined)[]; // face ごとの、窓の位置をずらした読みのコスト
  ids: (Int16Array | undefined)[]; // face ごとの、読んだステッカー（マスごとに違う ArUco ステッカー）
  idCost: (Float32Array | undefined)[];
}

// 姿勢 o のときカメラの面 slot のマス cell に見える facelet の逆引き: (slot * 9 + cell) * 54 + facelet → o（センターのマスは使わない: -1）
const ORIENT_AT = (() => {
  const t = new Int8Array(54 * 54).fill(-1);
  for (let o = 0; o < NUM_ORIENTATIONS; o++)
    for (let slot = 0; slot < 6; slot++)
      for (let cell = 0; cell < 9; cell++) if (cell !== 4) t[(slot * 9 + cell) * 54 + VIEW[(o * 6 + slot) * 9 + cell]] = o;
  return t;
})();
const ID_ORIENT_HYPS = 4; // ID から姿勢を求める仮説の数（上位から）
const ID_ORIENT_VOTES = 1.6; // 姿勢を候補に足すのに要る、その姿勢を示す読みの重みの和（読みの確からしさ 1 のステッカー 2 枚相当）

// ずらした格子の読みを使うときの上乗せ（見つかった格子の位置を少しだけ優先する。1 手のコスト 1.0 より小さく）
const ALT_PENALTY = 0.4;

function compile(obs: Observation, o: number): CompiledObs {
  const n = obs.faces.length * 9;
  const idx = new Int32Array(n);
  const costBase = new Int32Array(n);
  const faceOf = new Int32Array(n);
  obs.faces.forEach((f, k) => {
    for (let cell = 0; cell < 9; cell++) {
      idx[k * 9 + cell] = VIEW[(o * 6 + f.slot) * 9 + cell];
      costBase[k * 9 + cell] = cell * 6;
      faceOf[k * 9 + cell] = k;
    }
  });
  return { idx, costBase, costs: obs.faces.map((f) => f.cost), faceOf, alts: obs.faces.map((f) => f.alts), ids: obs.faces.map((f) => f.ids), idCost: obs.faces.map((f) => f.idCost) };
}

// limit: これ以上になったら（残りの面を足さずに）その時点の和を返す。コストは負にならないので、しきい値で捨てる候補は同じ
function evalCost(state: Uint8Array, c: CompiledObs, limit = Infinity): number {
  let sum = 0;
  for (let k = 0; k < c.costs.length; k++) {
    const base = k * 9;
    const main = c.costs[k];
    let s = 0;
    for (let i = base; i < base + 9; i++) s += main[c.costBase[i] + state[c.idx[i]]];
    // 読んだステッカー: 色が合っていて（色の矛盾は上で払っている）、仮説ではそこに別のステッカーがあるとき
    const ids = c.ids[k];
    if (ids) {
      const ic = c.idCost[k]!;
      for (let cell = 0; cell < 9; cell++) {
        const id = ids[cell];
        if (id < 0) continue;
        const f = c.idx[base + cell];
        if (state[f] === Math.floor(id / 9) && stickerIdAt(state, f) !== id) s += ic[cell];
      }
    }
    const alts = c.alts[k];
    if (alts)
      for (const a of alts) {
        let t = ALT_PENALTY;
        for (let i = base; i < base + 9 && t < s; i++) t += a[c.costBase[i] + state[c.idx[i]]];
        if (t < s) s = t;
      }
    sum += s;
    if (sum >= limit) return sum;
  }
  return sum;
}

// 大きさ k の「小さい方から k 個」のコストを保つ（k 番目 = 刈り込みのしきい値）
class TopK {
  private heap: number[] = []; // 最大ヒープ
  threshold = Infinity; // k 個たまるまでは無限大、その後は k 番目に小さいコスト
  constructor(private readonly k: number) {}
  push(v: number): void {
    this.insert(v);
    if (this.heap.length >= this.k) this.threshold = this.heap[0];
  }
  private insert(v: number): void {
    const h = this.heap;
    if (h.length < this.k) {
      h.push(v);
      let i = h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (h[p] >= h[i]) break;
        [h[p], h[i]] = [h[i], h[p]];
        i = p;
      }
    } else if (v < h[0]) {
      h[0] = v;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l] > h[m]) m = l;
        if (r < h.length && h[r] > h[m]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
  }
}

export class MoveDecoder {
  readonly options: DecoderOptions;
  private beam: Hypothesis[];
  private lastGoodBeam: Hypothesis[];
  private uncertainStreak = 0;
  status: TrackStatus = "tracking";
  observations = 0;
  lastObservationCost = 0;
  recoveries = 0;
  lastExpanded = 0; // 直近の観測で評価した候補数（性能の目安）
  // 仮説のコストは毎回最良を 0 に揃えている。揃えるために引いた量の合計（絶対的なコスト = cost + costOffset）
  costOffset = 0;
  private lastBase = 0;
  private lastGoodOffset = 0;
  prior: MovePrior | null;

  // orients を省略すると 24 姿勢すべてから始める（最初の観測で決まる）
  constructor(start: CubeState, options: Partial<DecoderOptions> = {}, orients?: number[]) {
    this.options = { ...DEFAULT_DECODER, ...options };
    this.prior = this.options.priorWeight > 0 ? movePrior() : null;
    const os = orients ?? Array.from({ length: NUM_ORIENTATIONS }, (_, i) => i);
    this.beam = os.map((orient) => ({ state: new Uint8Array(start), orient, cost: 0, obsCost: 0, tail: null }));
    this.lastGoodBeam = this.beam;
  }

  setOptions(options: Partial<DecoderOptions>): void {
    Object.assign(this.options, options);
  }

  // 観測の中心色から、ありうる姿勢を絞る（センターは動かないので、見えている中心色で姿勢がほぼ決まる）
  private orientationCandidates(obs: Observation): number[] {
    const centerCost = new Float64Array(NUM_ORIENTATIONS);
    let min = Infinity;
    for (let o = 0; o < NUM_ORIENTATIONS; o++) {
      let c = 0;
      for (const f of obs.faces) c += f.cost[4 * 6 + cubeFaceAt(o, f.slot)];
      centerCost[o] = c;
      if (c < min) min = c;
    }
    // 中心が見えていない（どの姿勢でも同じ）なら、24 通りすべては試さず、いまの仮説たちの姿勢だけにする
    // （中心以外のステッカーで持ち替えを判断できる余地は残しつつ、指で中心が隠れたときに探索が膨らまないように）
    let max = -Infinity;
    for (let o = 0; o < NUM_ORIENTATIONS; o++) max = Math.max(max, centerCost[o]);
    if (max - min < 0.5) return [...new Set([...this.beam.map((h) => h.orient), ...this.idOrientations(obs)])];
    const orients: number[] = [];
    for (let o = 0; o < NUM_ORIENTATIONS; o++) if (centerCost[o] <= min + 0.75) orients.push(o);
    return orients;
  }

  // 読んだステッカーの ID から、有力な仮説の状態で決まる姿勢（中心が見えないときの持ち替え）。センター以外のステッカーは、仮説の
  // 状態での位置と、見えたカメラの面・マスから姿勢が 1 つに決まる。2 枚以上が同じ姿勢を示すものだけ（回した層のステッカーは外れる）。
  // 実物のソルブで、正面 1 面だけが見えて真ん中が指で隠れたまま持ち替えると、いまの姿勢のまま手で説明して 12 秒見失っていた
  private idOrientations(obs: Observation): number[] {
    if (!obs.faces.some((f) => f.ids)) return [];
    const votes = new Float32Array(NUM_ORIENTATIONS);
    const seen = new Set<string>();
    for (const h of this.beam.slice(0, ID_ORIENT_HYPS)) {
      const key = String.fromCharCode(...h.state);
      if (seen.has(key)) continue;
      seen.add(key);
      const ids = stickerIds(h.state);
      const pos = new Int8Array(54);
      for (let f = 0; f < 54; f++) pos[ids[f]] = f;
      const v = new Float32Array(NUM_ORIENTATIONS);
      for (const face of obs.faces) {
        if (!face.ids) continue;
        for (let cell = 0; cell < 9; cell++) {
          const id: number = face.ids[cell];
          if (cell === 4 || id < 0) continue;
          const o = ORIENT_AT[(face.slot * 9 + cell) * 54 + pos[id]];
          if (o >= 0) v[o] += face.idCost?.[cell] ?? 1;
        }
      }
      for (let o = 0; o < NUM_ORIENTATIONS; o++) votes[o] = Math.max(votes[o], v[o]);
    }
    const out: number[] = [];
    for (let o = 0; o < NUM_ORIENTATIONS; o++) if (votes[o] >= ID_ORIENT_VOTES) out.push(o);
    return out;
  }

  private expand(beam: Hypothesis[], obs: Observation, depth: number, inferred: boolean): Hypothesis[] {
    const { moveCost, rotationCost, beamWidth } = this.options;
    const orients = this.orientationCandidates(obs);
    const compiled = new Map<number, CompiledObs>();
    const getCompiled = (o: number) => {
      let c = compiled.get(o);
      if (!c) compiled.set(o, (c = compile(obs, o)));
      return c;
    };
    const tree = sequenceTree(depth);
    const nodes = tree.move.length;
    const states = stateBuffers(tree);
    // 手順の木の各節点までの手のコスト（手順の知識で上乗せ）と、その時点の直前 3 手
    const prior = this.options.priorWeight > 0 ? this.prior : null;
    const pw = this.options.priorWeight;
    const minMove = moveCost; // 1 手のコストの下限（刈り込み用。上乗せは 0 以上）
    const pathCost = new Float32Array(nodes);
    const context = new Int32Array(nodes);
    const fillLevel = (h: Hypothesis, d: number) => {
      const from = tree.levelStart[d];
      const to = tree.levelStart[d + 1];
      if (d === 0) {
        let ctx = EMPTY_CONTEXT;
        const recent: number[] = [];
        for (let n = h.tail; n && recent.length < 3; n = n.prev) recent.push(n.move);
        for (let k = recent.length - 1; k >= 0; k--) ctx = shiftContext(ctx, recent[k]);
        pathCost[0] = 0;
        context[0] = ctx;
        return;
      }
      for (let node = from; node < to; node++) {
        const p = tree.parent[node];
        const m = tree.move[node];
        pathCost[node] = pathCost[p] + moveCost + (prior ? pw * prior.penalty(context[p], m) : 0);
        context[node] = shiftContext(context[p], m);
      }
    };
    const top = new TopK(beamWidth);
    // 回転途中の形で見えた層の回転: 仮説の姿勢でキューブの軸に直し、合わない手の並びにコストを足す
    const turns = obs.turns?.length ? obs.turns : null;
    const tt = turns ? treeTurns(tree) : null;
    const turnPenalty = (orient: number): ((node: number) => number) | null => {
      if (!turns || !tt) return null;
      // キューブの軸ごとに: 回した量の合計（null = 量の分からないものがある）
      const want = new Map<number, number | null>();
      for (const h of turns) {
        const a = AXIS_OF_FACE[cubeFaceAt(orient, h.slot)];
        const prev = want.get(a);
        want.set(a, h.quarters === null || prev === null ? null : ((prev ?? 0) + h.quarters) % 4);
      }
      const { turnCost, turnAxisCost } = this.options;
      return (node: number) => {
        let c = 0;
        for (const [a, q] of want) {
          if (q === null) c += tt.has[node * 3 + a] ? 0 : turnAxisCost;
          else if (!turnConsistent(q, tt.net[node * 3 + a])) c += turnCost;
        }
        return c;
      };
    };

    interface Cand {
      cost: number;
      obsCost: number;
      hyp: number;
      node: number;
      orient: number;
      moves: number;
      seq?: number[]; // 深く探して見つけた手順（手順の木の外）
    }
    const best = new Map<number, Cand>();
    let evaluated = 0;
    const order = beam.map((h, i) => ({ h, i })).sort((a, b) => a.h.cost - b.h.cost);

    // 読んだステッカーによる下限（上の「読んだステッカーの ID による枝刈り」）: 姿勢ごとの読み
    const consByOrient = new Map<number, IdConstraints>();
    const consOf = (o: number) => {
      let c = consByOrient.get(o);
      if (!c) consByOrient.set(o, (c = idConstraints(obs, o)));
      return c;
    };
    const perms = treePerms(tree);
    const stamps = stampCache.get(states)!;
    const pos = new Int8Array(54); // 仮説の状態で、ステッカー id がある facelet（なければ -1）
    // 姿勢ごとの、親の節点から手 m で進んだ子が必ず払うコスト: childLb[oi * NUM_MOVES + m]
    let childLb = new Float64Array(NUM_MOVES);
    let pass = new Uint8Array(1);
    const fix = new Float64Array(NUM_MOVES);
    const disturb = new Float64Array(6);

    // 仮説 h の、手順の木の深さ from〜to の節点を評価する。節点の状態は評価する節点とその親だけ作り、最後の段の手のコストは
    // 読みの下限を通った親の子だけ求める
    const evalLevels = (h: Hypothesis, hi: number, from: number, to: number) => {
      const os = orients.includes(h.orient) ? orients : [...orients, h.orient];
      const prevLen = h.tail?.len ?? 0;
      const penalty = turnPenalty(h.orient);
      const epoch = ++stampEpoch;
      const ensure = (node: number): Uint8Array => {
        const dst = states[node];
        if (stamps[node] === epoch) return dst;
        if (node === 0) dst.set(h.state);
        else {
          const src = ensure(tree.parent[node]);
          const p = MOVE_SRC[tree.move[node]];
          for (let i = 0; i < 54; i++) dst[i] = src[p[i]];
        }
        stamps[node] = epoch;
        return dst;
      };
      // 姿勢ごとの読み: あるはずのステッカーが、仮説の状態でいまある facelet
      const cons = os.map(this.options.idPrune ? consOf : () => NO_CONSTRAINTS);
      let where: Int8Array[] = [];
      if (cons.some((c) => c.n > 0)) {
        pos.fill(-1);
        for (let f = 0; f < 54; f++) {
          const id = stickerIdAt(h.state, f);
          if (id >= 0) pos[id] = f;
        }
        where = cons.map((c) => Int8Array.from(c.id, (id) => pos[id]));
      }
      if (childLb.length < os.length * NUM_MOVES) {
        childLb = new Float64Array(os.length * NUM_MOVES);
        pass = new Uint8Array(os.length);
      }
      const rot = os.map((o) => (o === h.orient ? 0 : rotationCost));
      // 節点 node（深さ d）を姿勢 os[oi] で評価する。base: 仮説のコスト + 手のコスト + 持ち替え
      const evalNode = (node: number, d: number, oi: number, base: number) => {
        const o = os[oi];
        const dst = ensure(node);
        const obsCost = evalCost(dst, getCompiled(o), top.threshold - base);
        evaluated++;
        const cost = base + obsCost;
        if (cost >= top.threshold) return;
        const key = combineKey(hashState(dst), o);
        const prev = best.get(key);
        const moves = prevLen + d;
        if (!prev || cost < prev.cost - 1e-9 || (Math.abs(cost - prev.cost) <= 1e-9 && moves < prev.moves)) {
          if (!prev) top.push(cost);
          best.set(key, { cost, obsCost, hyp: hi, node, orient: o, moves });
        }
      };
      // 深さ from より浅い段の手のコスト（親として要る）
      for (let d = 0; d < Math.max(1, from); d++) fillLevel(h, d);
      if (from === 0) {
        const pc = h.cost + (penalty ? penalty(0) : 0);
        for (let oi = 0; oi < os.length; oi++) if (pc + rot[oi] < top.threshold) evalNode(0, 0, oi, pc + rot[oi]);
      }
      for (let d = Math.max(1, from); d <= to; d++) {
        // この深さの手のコストだけでしきい値を超えるなら、それより深い節点も超える
        if (h.cost + d * minMove >= top.threshold) break;
        const last = d === to;
        for (let p = tree.levelStart[d - 1]; p < tree.levelStart[d]; p++) {
          const c0 = tree.firstChild[p];
          const c1 = tree.firstChild[p + 1];
          // 子の手のコストの下限（手順の知識の上乗せ・回転途中の形との矛盾は 0 以上）
          const floor = h.cost + pathCost[p] + minMove;
          if (floor >= top.threshold) {
            if (!last) for (let node = c0; node < c1; node++) pathCost[node] = Infinity;
            continue;
          }
          // 読んだステッカーによる下限: いま合っている読みはそのステッカーを動かす面の手で外れ、合っていない読みは合わせる手
          // （あっても 1〜2 通り）でしか合わない
          let any = false;
          for (let oi = 0; oi < os.length; oi++) {
            const c = cons[oi];
            if (floor + rot[oi] >= top.threshold) {
              pass[oi] = 0;
              continue;
            }
            if (!c.n) {
              pass[oi] = 1;
              any = true;
              continue;
            }
            let violated = 0;
            fix.fill(0);
            disturb.fill(0);
            const g = where[oi];
            const at = p * 54;
            for (let k = 0; k < c.n; k++) {
              const f = c.f[k];
              const a = g[k] < 0 ? -1 : perms[at + g[k]];
              if (a === f) {
                for (let j = f * 3; j < f * 3 + 3 && DISTURB[j] >= 0; j++) disturb[DISTURB[j]] += c.lb[k];
                continue;
              }
              violated += c.lb[k];
              let mask = a < 0 ? 0 : REACH1[a * 54 + f];
              while (mask) {
                const bit = 31 - Math.clz32(mask);
                fix[bit] += c.lb[k];
                mask ^= 1 << bit;
              }
            }
            const off = oi * NUM_MOVES;
            let min = Infinity;
            for (let m = 0; m < NUM_MOVES; m++) {
              const lb = violated - fix[m] + disturb[(m / 3) | 0];
              childLb[off + m] = lb;
              if (lb < min) min = lb;
            }
            pass[oi] = floor + rot[oi] + min - 1e-6 < top.threshold ? 1 : 0;
            if (pass[oi]) any = true;
          }
          if (!any && last) continue;
          for (let node = c0; node < c1; node++) {
            const m = tree.move[node];
            pathCost[node] = pathCost[p] + moveCost + (prior ? pw * prior.penalty(context[p], m) : 0);
            context[node] = shiftContext(context[p], m);
            if (!any) continue;
            const pc = h.cost + pathCost[node] + (penalty ? penalty(node) : 0);
            if (pc >= top.threshold) continue;
            for (let oi = 0; oi < os.length; oi++) {
              if (!pass[oi]) continue;
              const base = pc + rot[oi];
              if (base >= top.threshold) continue;
              if (cons[oi].n && base + childLb[oi * NUM_MOVES + m] - 1e-6 >= top.threshold) continue;
              evalNode(node, d, oi, base);
            }
          }
        }
      }
    };

    // 1) 全仮説を浅く（深さ 2 まで）
    const shallow = Math.min(depth, 2);
    for (const { h, i } of order) evalLevels(h, i, 0, shallow);
    // 2) 下限がしきい値より安い仮説だけ深く（2 手までで観測が説明できていれば省く）
    let bestShallowObs = Infinity;
    for (const c of best.values()) if (c.obsCost < bestShallowObs) bestShallowObs = c.obsCost;
    const deepen = depth > shallow && bestShallowObs > this.options.deepenAbove;
    for (const { h, i } of deepen ? order.slice(0, this.options.deepHyps) : []) {
      if (h.cost + (shallow + 1) * minMove >= top.threshold) continue;
      evalLevels(h, i, shallow + 1, depth);
    }
    // 3) 深く探す: それでも説明できないとき、有力な仮説から bridgeDepth 手まで、読んだステッカーがすべて合う手順だけを探す。
    // ライブはフレームを落とすので、速い手順では 1 つの観測に 4〜6 手入る（実物のソルブを 1 秒 10 枚で処理すると 4 手が 4 回）。
    // 全部の手順を評価すると 5 手で 60 万通りだが、読んだステッカー 1 枚ごとに「あと j 手で置けるか・最初の手は何か」が決まるので、
    // 合わせられない枝は入らずに済む（深さ優先。状態は見つけた手順だけ作る）
    const bridgeDepth = this.options.bridgeDepth;
    if (deepen && bridgeDepth > depth && !turns) {
      let bestObs = Infinity;
      for (const c of best.values()) if (c.obsCost < bestObs) bestObs = c.obsCost;
      if (bestObs > this.options.deepenAbove) {
        const scratch = new Uint8Array(54);
        const scratch2 = new Uint8Array(54);
        const searched = new Set<number>();
        for (const { h, i } of order.slice(0, this.options.deepHyps)) {
          // 同じ状態・姿勢の仮説（手順の書き方だけが違う）からは 1 回だけ探す
          const hk = combineKey(hashState(h.state), h.orient);
          if (searched.has(hk)) continue;
          searched.add(hk);
          const os = orients.includes(h.orient) ? orients : [...orients, h.orient];
          let filled = false;
          for (const o of os) {
            const c = consOf(o);
            if (c.n < BRIDGE_MIN_IDS) continue;
            if (!filled) {
              pos.fill(-1);
              for (let f = 0; f < 54; f++) {
                const id = stickerIdAt(h.state, f);
                if (id >= 0) pos[id] = f;
              }
              filled = true;
            }
            const n = c.n;
            const at = new Int8Array((bridgeDepth + 1) * n);
            let missing = false;
            for (let k = 0; k < n; k++) {
              at[k] = pos[c.id[k]];
              if (at[k] < 0) missing = true;
            }
            if (missing) continue;
            const rotC = o === h.orient ? 0 : rotationCost;
            const prevLen = h.tail?.len ?? 0;
            const strong = Array.from(c.lb, (v) => v > BRIDGE_MAX_OBS);
            const path: number[] = [];
            const ctx: number[] = [0];
            const cost: number[] = [0];
            {
              let c0 = EMPTY_CONTEXT;
              const recent: number[] = [];
              for (let nd = h.tail; nd && recent.length < 3; nd = nd.prev) recent.push(nd.move);
              for (let k = recent.length - 1; k >= 0; k--) c0 = shiftContext(c0, recent[k]);
              ctx[0] = c0;
            }
            const dfs = (d: number) => {
              const R = bridgeDepth - d; // あと何手まで足せるか（1 以上）
              const base = d * n;
              const last = d ? path[d - 1] : -1;
              // j 手（1〜min(R, 3)）で合わせるとき、最初の手になれない手のビット（どれかの読みを合わせられない手）: bad[j - 1]。
              // 読んだステッカーは全部合うことを求めるので、読みごとの表の OR だけで済む（読みの数だけの演算。弱い読み = 矛盾の
              // コストが BRIDGE_MAX_OBS 以下のものは数えない）
              const J = Math.min(R, 3);
              let bad1 = 0;
              let bad2 = 0;
              let bad3 = 0;
              // 子そのものを評価するのは、手順の木で評価していない深さだけ。4 手以上残っていれば下の段へは必ず進む
              const need1 = d + 1 > depth;
              const need23 = R < 4;
              if (need1) {
                const t1 = NOT_FIRST[0];
                for (let k = 0; k < n; k++) if (strong[k]) bad1 |= t1[at[base + k] * 54 + c.f[k]];
              }
              if (need23 && J >= 2) {
                const t2 = NOT_FIRST[1];
                for (let k = 0; k < n; k++) if (strong[k]) bad2 |= t2[at[base + k] * 54 + c.f[k]];
              }
              if (need23 && J >= 3) {
                const t3 = NOT_FIRST[2];
                for (let k = 0; k < n; k++) if (strong[k]) bad3 |= t3[at[base + k] * 54 + c.f[k]];
              }
              for (let m = 0; m < NUM_MOVES; m++) {
                if (redundantAfter(last, m)) continue;
                const pc = h.cost + rotC + cost[d] + moveCost + (prior ? pw * prior.penalty(ctx[d], m) : 0);
                if (pc >= top.threshold) continue;
                const bit = 1 << m;
                const evalChild = need1 && !(bad1 & bit);
                // さらに深く: あと 2 手以上で合わせられるか（4 手以上残っていれば、どのステッカーも届く）
                const go = R >= 4 || (J >= 2 && !(bad2 & bit) && pc + moveCost < top.threshold) || (J >= 3 && !(bad3 & bit) && pc + 2 * moveCost < top.threshold);
                if (!evalChild && !go) continue;
                const dstTable = MOVE_DST[m];
                for (let k = 0; k < n; k++) at[base + n + k] = dstTable[at[base + k]];
                path[d] = m;
                cost[d + 1] = cost[d] + moveCost + (prior ? pw * prior.penalty(ctx[d], m) : 0);
                ctx[d + 1] = shiftContext(ctx[d], m);
                if (evalChild) {
                  // 状態を作って評価する
                  let src: Uint8Array = h.state;
                  for (let k = 0; k <= d; k++) {
                    const dst = k % 2 ? scratch2 : scratch;
                    const p = MOVE_SRC[path[k]];
                    for (let q = 0; q < 54; q++) dst[q] = src[p[q]];
                    src = dst;
                  }
                  const obsCost = evalCost(src, getCompiled(o), top.threshold - pc);
                  evaluated++;
                  const total = pc + obsCost;
                  if (total < top.threshold) {
                    const key = combineKey(hashState(src), o);
                    const prev = best.get(key);
                    const moves = prevLen + d + 1;
                    if (!prev || total < prev.cost - 1e-9 || (Math.abs(total - prev.cost) <= 1e-9 && moves < prev.moves)) {
                      if (!prev) top.push(total);
                      best.set(key, { cost: total, obsCost, hyp: i, node: 0, orient: o, moves, seq: path.slice(0, d + 1) });
                    }
                  }
                }
                if (go && R > 1) dfs(d + 1);
              }
            };
            dfs(0);
          }
        }
      }
    }
    this.lastExpanded = evaluated;

    const sorted = [...best.values()].sort((a, b) => a.cost - b.cost || a.moves - b.moves);
    const kept = sorted.slice(0, beamWidth);
    const t0 = obs.tPrevEnd;
    const t1 = Math.max(obs.tPrevEnd, obs.t);
    const base = kept.length ? kept[0].cost : 0;
    this.lastBase = base;
    return kept.map((c) => {
      const h = beam[c.hyp];
      const seq = c.seq ?? seqOf(tree, c.node);
      let state = h.state;
      let tail = h.tail;
      seq.forEach((m, k) => {
        const next = new Uint8Array(54);
        const p = MOVE_SRC[m];
        for (let i = 0; i < 54; i++) next[i] = state[p[i]];
        state = next;
        // 1観測に複数手が入るときは、前の観測の終わりから今回の観測までを等分する
        const a = t0 + ((t1 - t0) * k) / seq.length;
        const b = t0 + ((t1 - t0) * (k + 1)) / seq.length;
        tail = { move: m, t0: a, t: b, orient: c.orient, inferred, prev: tail, len: (tail?.len ?? 0) + 1 };
      });
      return { state: seq.length ? state : h.state, orient: c.orient, cost: c.cost - base, obsCost: c.obsCost, tail, origin: h.origin };
    });
  }

  observe(obs: Observation): void {
    if (!obs.faces.length) return;
    this.observations++;
    const next = this.expand(this.beam, obs, this.options.maxMovesPerStep, false);
    this.costOffset += this.lastBase;
    const bestObs = next[0]?.obsCost ?? Infinity;
    this.lastObservationCost = bestObs;
    if (bestObs <= this.options.uncertainCost) {
      this.beam = next;
      this.uncertainStreak = 0;
      this.lastGoodBeam = next;
      this.lastGoodOffset = this.costOffset;
      this.status = "tracking";
      return;
    }
    this.uncertainStreak++;
    this.beam = next;
    this.status = "uncertain";
    if (this.uncertainStreak >= this.options.lostAfter) {
      // 見失い: 最後に辻褄が合っていた時点から、より深く探す
      const seeds = this.lastGoodBeam.slice(0, 6);
      const recovered = this.expand(seeds, obs, Math.max(this.options.recoveryDepth, this.options.maxMovesPerStep), true);
      if (recovered.length && recovered[0].obsCost <= this.options.uncertainCost) {
        // 復帰の仮説は、最後に辻褄が合っていた時点のコストからの続き
        this.costOffset = this.lastGoodOffset + this.lastBase;
        this.lastGoodOffset = this.costOffset;
        this.beam = recovered;
        this.lastGoodBeam = recovered;
        this.uncertainStreak = 0;
        this.status = "tracking";
        this.recoveries++;
      } else {
        this.status = "lost";
      }
    }
  }

  // 最後の状態が分かっている（タイマーで完成を検出したなど）: 有力な仮説のうち、
  // その状態にたどり着く（必要なら maxExtra 手まで足す）最も安いものを選ぶ。足した手は inferred。
  finish(target: CubeState, t: number, maxExtra = 2, margin = 6): DecodedMove[] | null {
    const tree = sequenceTree(maxExtra);
    let bestCost = Infinity;
    let bestMoves: DecodedMove[] | null = null;
    const base = this.beam[0]?.cost ?? 0;
    for (const h of this.beam) {
      if (h.cost > base + margin) continue;
      const states = stateBuffers(tree); // 木ごとの入れ物を使い回す（深さ 4 で 4.8 万節点）
      for (let node = 0; node < tree.move.length; node++) {
        if (node === 0) states[0].set(h.state);
        else {
          const p = MOVE_SRC[tree.move[node]];
          const src = states[tree.parent[node]];
          for (let i = 0; i < 54; i++) states[node][i] = src[p[i]];
        }
        let d = 0;
        for (let n = node; n > 0; n = tree.parent[n]) d++;
        const cost = h.cost + d * this.options.moveCost;
        if (cost < bestCost && statesEqual(states[node], target)) {
          bestCost = cost;
          bestMoves = [...toList(h.tail), ...seqOf(tree, node).map((m) => ({ move: m, t0: t, t, orient: h.orient, inferred: true }))];
        }
      }
    }
    return bestMoves;
  }

  best(): Hypothesis {
    return this.beam[0];
  }

  hypotheses(): readonly Hypothesis[] {
    return this.beam;
  }

  bestMoves(): DecodedMove[] {
    return toList(this.beam[0].tail);
  }

  // 有力な仮説がすべて一致している手（以後ひっくり返らない前提で表示してよい）
  confirmedCount(): number {
    const { confirmMargin } = this.options;
    const near = this.beam.filter((h) => h.cost <= this.beam[0].cost + confirmMargin);
    const lists = near.map((h) => {
      const arr: MoveNode[] = [];
      for (let n = h.tail; n; n = n.prev) arr.push(n);
      return arr.reverse();
    });
    let n = lists[0].length;
    for (const l of lists) {
      let k = 0;
      while (k < n && k < l.length && (l[k] === lists[0][k] || l[k].move === lists[0][k].move)) k++;
      n = k;
    }
    return n;
  }

  // 2位とのコスト差（0 = 拮抗）
  margin(): number {
    return this.beam.length > 1 ? this.beam[1].cost - this.beam[0].cost : Infinity;
  }

  // 状態を外から確定させる（再スキャン後など）
  reset(state: CubeState, orients?: number[]): void {
    const os = orients ?? Array.from({ length: NUM_ORIENTATIONS }, (_, i) => i);
    this.beam = os.map((orient) => ({ state: new Uint8Array(state), orient, cost: 0, obsCost: 0, tail: null }));
    this.lastGoodBeam = this.beam;
    this.uncertainStreak = 0;
    this.status = "tracking";
  }

  // ライブの作り変え: 見えている色に合わせて作った状態を、今の最良の仮説と同じ手順の続きとして仮説に足す（今の仮説たちは残す）。
  // コストは最良の仮説のこの観測の前までのコスト + 作った状態の観測のコスト + extra。誤読が続かなければ、次の観測で元の仮説が
  // 勝ち直す（追跡ごと置き換えていた間は、一瞬の誤読で見えていない面まで作った状態になり、手順は正しいのに最後の状態が違った）
  inject(state: CubeState, orient: number, obsCost: number, origin: HypothesisOrigin, extra: number): void {
    const b = this.beam[0];
    const h: Hypothesis = { state: new Uint8Array(state), orient, cost: b.cost - b.obsCost + obsCost + extra, obsCost, tail: b.tail, origin };
    const lost = this.status === "lost";
    this.beam = (lost ? [h] : [h, ...this.beam]).sort((x, y) => x.cost - y.cost).slice(0, this.options.beamWidth);
    this.lastGoodBeam = this.beam;
    this.lastObservationCost = this.beam[0].obsCost;
    this.uncertainStreak = 0;
    this.status = "tracking";
  }
}

// 状態 state・姿勢 o の仮説に対する観測の矛盾コスト（調査用。デコーダの中と同じ計算）
export function observationCost(state: Uint8Array, o: number, obs: Observation): number {
  return evalCost(state, compile(obs, o));
}
