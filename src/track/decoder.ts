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
import { MOVE_SRC, NUM_MOVES, NUM_ORIENTATIONS, OPPOSITE, VIEW, type CubeState, cubeFaceAt, moveFace, statesEqual } from "../cube/model";
import { stickerIdAt } from "../cube/stickers";
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
}

// 状態 + 姿勢の 53bit ハッシュ（衝突確率は無視できる）
function hashState(s: Uint8Array): [number, number] {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < 54; i++) {
    h1 = Math.imul(h1 ^ s[i], 0x01000193);
    h2 = Math.imul(h2 ^ (s[i] + i * 7), 0x5bd1e995);
    h2 ^= h2 >>> 13;
  }
  return [h1 >>> 0, h2 >>> 0];
}
const combineKey = (h: [number, number], o: number) => (h[0] & 0x1fffff) * 0x100000000 + (((h[1] ^ Math.imul(o + 1, 0x9e3779b1)) >>> 0));

// 展開する手順の木（深さごとに並べ、親の状態から1手だけ進めて子の状態を作る）。
// 同じ面の連続（R R）と、反対面の並べ替え（L R と R L）は同じ状態になるので片方だけ作る。
interface SeqTree {
  move: Int8Array; // 最後の手
  parent: Int32Array; // 1手短い親の番号（深さ0は -1）
  levelStart: number[]; // levelStart[d] .. levelStart[d+1]-1 が深さ d
}
const treeCache = new Map<number, SeqTree>();
function sequenceTree(depth: number): SeqTree {
  let t = treeCache.get(depth);
  if (t) return t;
  const move: number[] = [-1];
  const parent: number[] = [-1];
  const levelStart = [0, 1];
  for (let d = 1; d <= depth; d++) {
    const from = levelStart[d - 1];
    const to = levelStart[d];
    for (let p = from; p < to; p++) {
      const last = move[p];
      for (let m = 0; m < NUM_MOVES; m++) {
        if (last >= 0) {
          const fa = moveFace(last);
          const fb = moveFace(m);
          if (fb === fa || (OPPOSITE[fa] === fb && fa > fb)) continue;
        }
        move.push(m);
        parent.push(p);
      }
    }
    levelStart.push(move.length);
  }
  t = { move: Int8Array.from(move), parent: Int32Array.from(parent), levelStart };
  treeCache.set(depth, t);
  return t;
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

function evalCost(state: Uint8Array, c: CompiledObs): number {
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
  }
  return sum;
}

// 大きさ k の「小さい方から k 個」のコストを保つ（k 番目 = 刈り込みのしきい値）
class TopK {
  private heap: number[] = []; // 最大ヒープ
  constructor(private readonly k: number) {}
  get threshold(): number {
    return this.heap.length < this.k ? Infinity : this.heap[0];
  }
  push(v: number): void {
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
    if (max - min < 0.5) return [...new Set(this.beam.map((h) => h.orient))];
    const orients: number[] = [];
    for (let o = 0; o < NUM_ORIENTATIONS; o++) if (centerCost[o] <= min + 0.75) orients.push(o);
    return orients;
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
    const states = Array.from({ length: nodes }, () => new Uint8Array(54));
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

    interface Cand {
      cost: number;
      obsCost: number;
      hyp: number;
      node: number;
      orient: number;
      moves: number;
    }
    const best = new Map<number, Cand>();
    let evaluated = 0;
    const order = beam.map((h, i) => ({ h, i })).sort((a, b) => a.h.cost - b.h.cost);

    // 深さ d の節点を、仮説 h について評価する（親の深さ d-1 の状態は states に入っている前提）
    const evalLevel = (h: Hypothesis, hi: number, d: number) => {
      const os = orients.includes(h.orient) ? orients : [...orients, h.orient];
      const prevLen = h.tail?.len ?? 0;
      fillLevel(h, d);
      const from = tree.levelStart[d];
      const to = tree.levelStart[d + 1];
      for (let node = from; node < to; node++) {
        const dst = states[node];
        if (d === 0) dst.set(h.state);
        else {
          const p = MOVE_SRC[tree.move[node]];
          const src = states[tree.parent[node]];
          for (let i = 0; i < 54; i++) dst[i] = src[p[i]];
        }
        let hash: [number, number] | null = null;
        for (const o of os) {
          const base = h.cost + pathCost[node] + (o === h.orient ? 0 : rotationCost);
          if (base >= top.threshold) continue;
          const obsCost = evalCost(dst, getCompiled(o));
          evaluated++;
          const cost = base + obsCost;
          if (cost >= top.threshold) continue;
          hash ??= hashState(dst);
          const key = combineKey(hash, o);
          const prev = best.get(key);
          const moves = prevLen + d;
          if (!prev || cost < prev.cost - 1e-9 || (Math.abs(cost - prev.cost) <= 1e-9 && moves < prev.moves)) {
            if (!prev) top.push(cost);
            best.set(key, { cost, obsCost, hyp: hi, node, orient: o, moves });
          }
        }
      }
    };

    // 1) 全仮説を浅く（深さ 2 まで）
    const shallow = Math.min(depth, 2);
    for (const { h, i } of order) for (let d = 0; d <= shallow; d++) evalLevel(h, i, d);
    // 2) 下限がしきい値より安い仮説だけ深く（2 手までで観測が説明できていれば省く）
    let bestShallowObs = Infinity;
    for (const c of best.values()) if (c.obsCost < bestShallowObs) bestShallowObs = c.obsCost;
    const deepen = depth > shallow && bestShallowObs > this.options.deepenAbove;
    for (const { h, i } of deepen ? order : []) {
      if (depth <= shallow || h.cost + (shallow + 1) * minMove >= top.threshold) continue;
      for (let d = 0; d <= shallow; d++) {
        fillLevel(h, d);
        // 深さ 2 までの状態を作り直す（評価は済んでいるので状態だけ）
        const from = tree.levelStart[d];
        const to = tree.levelStart[d + 1];
        for (let node = from; node < to; node++) {
          if (d === 0) states[node].set(h.state);
          else {
            const p = MOVE_SRC[tree.move[node]];
            const src = states[tree.parent[node]];
            const dst = states[node];
            for (let k = 0; k < 54; k++) dst[k] = src[p[k]];
          }
        }
      }
      for (let d = shallow + 1; d <= depth; d++) {
        if (h.cost + d * minMove >= top.threshold) break;
        evalLevel(h, i, d);
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
      const seq = seqOf(tree, c.node);
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
      return { state: seq.length ? state : h.state, orient: c.orient, cost: c.cost - base, obsCost: c.obsCost, tail };
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
      const states = Array.from({ length: tree.move.length }, () => new Uint8Array(54));
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

  // 別の経路（精密解析）が決めた状態・姿勢・手順に乗り換える。prefix がそれまでの手順になる
  rebase(state: CubeState, orient: number, prefix: DecodedMove[]): void {
    let tail = null as MoveNode | null;
    prefix.forEach((m, i) => {
      tail = { move: m.move, t0: m.t0 ?? m.t, t: m.t, orient: m.orient, inferred: !!m.inferred, prev: tail, len: i + 1 };
    });
    this.beam = [{ state: new Uint8Array(state), orient, cost: 0, obsCost: 0, tail }];
    this.lastGoodBeam = this.beam;
    this.uncertainStreak = 0;
    this.status = "tracking";
  }
}

// 状態 state・姿勢 o の仮説に対する観測の矛盾コスト（調査用。デコーダの中と同じ計算）
export function observationCost(state: Uint8Array, o: number, obs: Observation): number {
  return evalCost(state, compile(obs, o));
}
