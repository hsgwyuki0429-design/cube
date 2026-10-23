// 手順デコーダ（ビームサーチ）。
//
// 仮説 = (キューブ状態, キューブの姿勢)。安定した観測が来るたびに、各仮説を 0〜maxMovesPerStep 手だけ
// 展開し、姿勢の変化（持ち替え）も候補に入れる。観測と矛盾するステッカーごとにコストを払い、
// 安いものだけ beamWidth 個残す。見えない面の回転（カメラの反対側など）は、その影響が
// 見える面に現れた時点で遡って推定される。
//
// 映像から直接手順を組み立てるのではなく、「候補手を状態機械で適用し、予測される見え方と照合する」。
//
// 参考: AllefDouglasDev/rubik-cube (MIT) の app/src/tracking/decoder.ts のビームサーチを基に、
// 姿勢（24通り）を仮説に含め、ソフトな色コストと見失い検出・復帰を加えたもの。
import { MOVE_SRC, NUM_MOVES, NUM_ORIENTATIONS, OPPOSITE, VIEW, type CubeState, cubeFaceAt, moveFace } from "../cube/model";
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
}

export const DEFAULT_DECODER: DecoderOptions = {
  beamWidth: 32,
  maxMovesPerStep: 2,
  moveCost: 1,
  rotationCost: 1.5,
  confirmMargin: 2.5,
  uncertainCost: 3.2,
  lostAfter: 3,
  recoveryDepth: 3,
};

interface MoveNode {
  move: number;
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

function* moveSequences(depth: number): Generator<number[]> {
  yield [];
  if (depth < 1) return;
  for (let a = 0; a < NUM_MOVES; a++) {
    yield [a];
    if (depth < 2) continue;
    const fa = moveFace(a);
    for (let b = 0; b < NUM_MOVES; b++) {
      const fb = moveFace(b);
      if (fb === fa || (OPPOSITE[fa] === fb && fa > fb)) continue;
      yield [a, b];
      if (depth < 3) continue;
      for (let c = 0; c < NUM_MOVES; c++) {
        const fc = moveFace(c);
        if (fc === fb || (OPPOSITE[fb] === fc && fb > fc)) continue;
        yield [a, b, c];
        if (depth < 4) continue;
        for (let d = 0; d < NUM_MOVES; d++) {
          const fd = moveFace(d);
          if (fd === fc || (OPPOSITE[fc] === fd && fc > fd)) continue;
          yield [a, b, c, d];
        }
      }
    }
  }
}

// 展開する手順の木（深さごとに親子で再利用するため、前計算しておく）
interface SeqTree {
  seqs: number[][];
  parent: Int32Array; // 1手短い親の番号（深さ0は -1）
}
const treeCache = new Map<number, SeqTree>();
function sequenceTree(depth: number): SeqTree {
  let t = treeCache.get(depth);
  if (!t) {
    const seqs = [...moveSequences(depth)];
    const index = new Map(seqs.map((s, i) => [s.join(","), i]));
    const parent = new Int32Array(seqs.length);
    seqs.forEach((s, i) => (parent[i] = s.length ? index.get(s.slice(0, -1).join(","))! : -1));
    t = { seqs, parent };
    treeCache.set(depth, t);
  }
  return t;
}

function toList(tail: MoveNode | null): DecodedMove[] {
  const out: DecodedMove[] = [];
  for (let n = tail; n; n = n.prev) out.push({ move: n.move, t: n.t, orient: n.orient, ...(n.inferred ? { inferred: true } : {}) });
  return out.reverse();
}

// 観測のうち、姿勢 o で見たときに参照する facelet と cost のペアを平坦化
interface CompiledObs {
  idx: Int32Array; // facelet 番号
  costBase: Int32Array; // cost 配列内のオフセット（cell*6）
  costs: Float32Array[]; // face ごと
  faceOf: Int32Array;
}

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
  return { idx, costBase, costs: obs.faces.map((f) => f.cost), faceOf };
}

function evalCost(state: Uint8Array, c: CompiledObs): number {
  let sum = 0;
  for (let i = 0; i < c.idx.length; i++) sum += c.costs[c.faceOf[i]][c.costBase[i] + state[c.idx[i]]];
  return sum;
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

  // orients を省略すると 24 姿勢すべてから始める（最初の観測で決まる）
  constructor(start: CubeState, options: Partial<DecoderOptions> = {}, orients?: number[]) {
    this.options = { ...DEFAULT_DECODER, ...options };
    const os = orients ?? Array.from({ length: NUM_ORIENTATIONS }, (_, i) => i);
    this.beam = os.map((orient) => ({ state: new Uint8Array(start), orient, cost: 0, obsCost: 0, tail: null }));
    this.lastGoodBeam = this.beam;
  }

  setOptions(options: Partial<DecoderOptions>): void {
    Object.assign(this.options, options);
  }

  // 観測の中心色から、ありうる姿勢を絞る（センターは動かないので、見えている中心色で姿勢がほぼ決まる）
  private orientationCandidates(obs: Observation): { orients: number[]; centerCost: Float64Array } {
    const centerCost = new Float64Array(NUM_ORIENTATIONS);
    let min = Infinity;
    for (let o = 0; o < NUM_ORIENTATIONS; o++) {
      let c = 0;
      for (const f of obs.faces) c += f.cost[4 * 6 + cubeFaceAt(o, f.slot)];
      centerCost[o] = c;
      if (c < min) min = c;
    }
    const orients: number[] = [];
    for (let o = 0; o < NUM_ORIENTATIONS; o++) if (centerCost[o] <= min + 0.75) orients.push(o);
    return { orients, centerCost };
  }

  private expand(beam: Hypothesis[], obs: Observation, depth: number, inferred: boolean): Hypothesis[] {
    const { moveCost, rotationCost, beamWidth } = this.options;
    const { orients } = this.orientationCandidates(obs);
    const compiled = new Map<number, CompiledObs>();
    const getCompiled = (o: number) => {
      let c = compiled.get(o);
      if (!c) compiled.set(o, (c = compile(obs, o)));
      return c;
    };
    const tree = sequenceTree(depth);
    const nSeq = tree.seqs.length;
    const states = Array.from({ length: nSeq }, () => new Uint8Array(54));

    interface Cand {
      cost: number;
      obsCost: number;
      hyp: number;
      seq: number;
      orient: number;
      key: number;
      moves: number;
    }
    const best = new Map<number, Cand>();
    beam.forEach((h, hi) => {
      states[0].set(h.state);
      for (let si = 1; si < nSeq; si++) {
        const seq = tree.seqs[si];
        const p = MOVE_SRC[seq[seq.length - 1]];
        const src = states[tree.parent[si]];
        const dst = states[si];
        for (let i = 0; i < 54; i++) dst[i] = src[p[i]];
      }
      const os = orients.includes(h.orient) ? orients : [...orients, h.orient];
      const prevLen = h.tail?.len ?? 0;
      for (let si = 0; si < nSeq; si++) {
        const hash = hashState(states[si]);
        const seqLen = tree.seqs[si].length;
        for (const o of os) {
          const obsCost = evalCost(states[si], getCompiled(o));
          const cost = h.cost + seqLen * moveCost + (o === h.orient ? 0 : rotationCost) + obsCost;
          const key = combineKey(hash, o);
          const prev = best.get(key);
          const moves = prevLen + seqLen;
          if (!prev || cost < prev.cost - 1e-9 || (Math.abs(cost - prev.cost) <= 1e-9 && moves < prev.moves)) {
            best.set(key, { cost, obsCost, hyp: hi, seq: si, orient: o, key, moves });
          }
        }
      }
    });

    const sorted = [...best.values()].sort((a, b) => a.cost - b.cost || a.moves - b.moves);
    const kept = sorted.slice(0, beamWidth);
    const t0 = obs.tPrevEnd;
    const t1 = Math.max(obs.tPrevEnd, obs.t);
    const base = kept.length ? kept[0].cost : 0;
    return kept.map((c) => {
      const h = beam[c.hyp];
      const seq = tree.seqs[c.seq];
      let state = h.state;
      let tail = h.tail;
      seq.forEach((m, k) => {
        const next = new Uint8Array(54);
        const p = MOVE_SRC[m];
        for (let i = 0; i < 54; i++) next[i] = state[p[i]];
        state = next;
        const t = seq.length === 1 ? (t0 + t1) / 2 : t0 + ((t1 - t0) * (k + 1)) / (seq.length + 1);
        tail = { move: m, t, orient: c.orient, inferred, prev: tail, len: (tail?.len ?? 0) + 1 };
      });
      return { state: seq.length ? state : h.state, orient: c.orient, cost: c.cost - base, obsCost: c.obsCost, tail };
    });
  }

  observe(obs: Observation): void {
    if (!obs.faces.length) return;
    this.observations++;
    const next = this.expand(this.beam, obs, this.options.maxMovesPerStep, false);
    const bestObs = next[0]?.obsCost ?? Infinity;
    this.lastObservationCost = bestObs;
    if (bestObs <= this.options.uncertainCost) {
      this.beam = next;
      this.uncertainStreak = 0;
      this.lastGoodBeam = next;
      this.status = "tracking";
      return;
    }
    this.uncertainStreak++;
    this.beam = next;
    this.status = "uncertain";
    if (this.uncertainStreak >= this.options.lostAfter) {
      // 見失い: 最後に辻褄が合っていた時点から、より深く探す
      const seeds = this.lastGoodBeam.slice(0, 6);
      const recovered = this.expand(seeds, obs, this.options.recoveryDepth, true);
      if (recovered.length && recovered[0].obsCost <= this.options.uncertainCost) {
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
}
