// ソルブ後の手順の再構成（時間をかけてよい、正確さ優先の経路）。リアルタイムの追跡とは別に動かす。
//
// 始まりの状態（スクランブル後）と終わりの状態（完成）の両方が分かっているので、
//   前向き: 始まりの状態から、観測を順に説明する仮説をたくさん（ビーム）持って進める
//   後ろ向き: 終わりの状態から、観測を逆順に説明する仮説を持って戻る（手は逆向きになる）
// の 2 本を走らせ、途中のどこかの観測で「同じ状態・同じ姿勢」になる仮説どうしを、合計のコストが
// 最も小さくなる所でつなぐ。指で隠れて途中がしばらく分からなくても、前後の両側から辻褄の合う道を選べる。
// つながらなければ、前向きの結果を終わりの状態に合わせる（finish）。
import { type CubeState, MOVE_SRC, NUM_MOVES, OPPOSITE, inverseMove, moveFace, statesEqual } from "../cube/model";
import { type DecoderOptions, type Hypothesis, MoveDecoder } from "./decoder";
import { movePrior } from "./prior";
import type { DecodedMove, Observation } from "./types";

export interface OfflineOptions {
  decoder: Partial<DecoderOptions>;
  personal?: number[][]; // 自分のソルブの手順（手順の知識に加える）
}

export const DEFAULT_OFFLINE: OfflineOptions = {
  // 見失いからの復帰探索はしない（前後からつなぐ・橋渡しで補う方が正確で速い）
  decoder: { beamWidth: 64, maxMovesPerStep: 3, lostAfter: 1000 },
};

export interface OfflineResult {
  moves: DecodedMove[];
  method: "meet" | "bridge" | "forward-finish" | "forward";
  meetAt: number; // つないだ観測の番号（meet のとき）
  cost: number;
  reachedEnd: boolean;
}

interface Snapshot {
  hyps: Hypothesis[];
  offset: number;
}

function listOf(h: Hypothesis): DecodedMove[] {
  const out: DecodedMove[] = [];
  for (let n = h.tail; n; n = n.prev) out.push({ move: n.move, t0: n.t0, t: n.t, orient: n.orient, ...(n.inferred ? { inferred: true } : {}) });
  return out.reverse();
}

function key(h: Hypothesis): string {
  return `${h.orient}:${String.fromCharCode(...h.state)}`;
}

// 時間を逆にした観測の並び（k 番目の観測を、逆向きでは N-1-k 番目に）
export function reversedObservations(obs: Observation[], lastT: number): Observation[] {
  const n = obs.length;
  const out: Observation[] = [];
  for (let j = 0; j < n; j++) {
    const k = n - 1 - j;
    const next = obs[k + 1];
    // 観測 k の見え方が続いていた終わり = 次の観測の tPrevEnd。逆向きでは、その時刻が「見え始め」になる
    const t = next ? -next.tPrevEnd : -lastT;
    const tPrevEnd = next ? -next.t : -lastT;
    // 層の回転の手がかりは、次の観測（逆向きでは、この観測に着くまでの手）のものを逆向きに
    const turns = next?.turns?.map((h) => ({ slot: h.slot, quarters: h.quarters === null ? null : (4 - h.quarters) % 4 }));
    out.push({ ...obs[k], t, tPrevEnd: Math.min(tPrevEnd, t), turns });
  }
  return out;
}

export function decodeOffline(obs: Observation[], start: CubeState, end: CubeState | null, lastT: number, options: OfflineOptions = DEFAULT_OFFLINE): OfflineResult {
  const valid = obs.filter((o) => o.faces.length);
  const fwd = new MoveDecoder(start, options.decoder);
  if (options.personal?.length && fwd.prior) fwd.prior = movePrior(options.personal);
  const F: Snapshot[] = [];
  for (const o of valid) {
    fwd.observe(o);
    F.push({ hyps: [...fwd.hypotheses()], offset: fwd.costOffset });
  }
  const forwardBest = (): OfflineResult => {
    const moves = fwd.bestMoves();
    return { moves, method: "forward", meetAt: -1, cost: fwd.costOffset, reachedEnd: end ? statesEqual(fwd.best().state, end) : true };
  };
  if (!end || !valid.length) return forwardBest();

  const bwd = new MoveDecoder(end, options.decoder);
  bwd.prior = fwd.prior;
  const rev = reversedObservations(valid, lastT);
  const B: Snapshot[] = new Array(valid.length);
  rev.forEach((o, j) => {
    bwd.observe(o);
    B[valid.length - 1 - j] = { hyps: [...bwd.hypotheses()], offset: bwd.costOffset };
  });

  // つなぐ: 観測 k の時点で同じ状態・姿勢の仮説（観測 k のコストは両方に入っているので 1 回引く）
  let best: { cost: number; k: number; f: Hypothesis; b: Hypothesis } | null = null;
  for (let k = 0; k < valid.length; k++) {
    const fm = new Map<string, Hypothesis>();
    for (const h of F[k].hyps) {
      const kk = key(h);
      const prev = fm.get(kk);
      if (!prev || h.cost < prev.cost) fm.set(kk, h);
    }
    for (const b of B[k].hyps) {
      const f = fm.get(key(b));
      if (!f) continue;
      const cost = f.cost + F[k].offset + b.cost + B[k].offset - f.obsCost;
      if (!best || cost < best.cost) best = { cost, k, f, b };
    }
  }
  if (best) {
    const head = listOf(best.f);
    // 後ろ向きの手は、逆の手を逆の順に。時刻も反転する
    const tail = listOf(best.b)
      .reverse()
      .map((m) => ({ ...m, move: inverseMove(m.move), t0: -m.t, t: -(m.t0 ?? m.t) }));
    return { moves: [...head, ...tail], method: "meet", meetAt: best.k, cost: best.cost, reachedEnd: true };
  }
  // つながらない（前後どちらも、隠れていた同じ区間で見失った）: 隠れる前の前向きの仮説と、隠れた後の後ろ向きの仮説を、
  // 短い手順（最大 6 手）でつなぐ。途中の手は直接見えていないので inferred
  const bridged = bridge(F, B, valid);
  if (bridged) return bridged;
  // それでもつながらない: 前向きの結果を、終わりの状態にたどり着くよう補う
  const fixed = fwd.finish(end, lastT, 2);
  if (fixed) return { moves: fixed, method: "forward-finish", meetAt: -1, cost: fwd.costOffset, reachedEnd: true };
  return forwardBest();
}

// ---- 隠れた区間の橋渡し ----

function hash53(s: Uint8Array): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < 54; i++) {
    h1 = Math.imul(h1 ^ s[i], 0x01000193);
    h2 = Math.imul(h2 ^ (s[i] + i * 7), 0x5bd1e995);
    h2 ^= h2 >>> 13;
  }
  return (h1 >>> 0) * 0x200000 + ((h2 >>> 0) & 0x1fffff);
}

interface Reach {
  path: number[]; // 起点から（後ろ向きなら、起点へ戻る向きの手を順に）
}

// 起点の状態から depth 手以内で届く状態（同じ面の連続・反対面の並べ替えは片方だけ）
function reachable(start: Uint8Array, depth: number, out: Map<number, Reach>, limit: number): void {
  const stack: { s: Uint8Array; path: number[] }[] = [{ s: start, path: [] }];
  while (stack.length) {
    const { s, path } = stack.pop()!;
    const k = hash53(s);
    const prev = out.get(k);
    if (!prev || prev.path.length > path.length) out.set(k, { path });
    if (out.size > limit || path.length >= depth) continue;
    const last = path[path.length - 1];
    for (let m = 0; m < NUM_MOVES; m++) {
      if (last !== undefined) {
        const fa = moveFace(last);
        const fb = moveFace(m);
        if (fb === fa || (OPPOSITE[fa] === fb && fa > fb)) continue;
      }
      const next = new Uint8Array(54);
      const p = MOVE_SRC[m];
      for (let i = 0; i < 54; i++) next[i] = s[p[i]];
      stack.push({ s: next, path: [...path, m] });
    }
  }
}

function bridge(F: Snapshot[], B: Snapshot[], obs: Observation[]): OfflineResult | null {
  const N = obs.length;
  const TOP = 16;
  const DEPTH = 3;
  type Best = { cost: number; k1: number; k2: number; f: Hypothesis; b: Hypothesis; mid: number[] };
  let best = null as Best | null;
  // 観測 k の前向きの上位の仮説から 3 手で届く状態を 1 つの表に（同じ状態なら安い方）
  type Entry = { f: Hypothesis; path: number[]; cost: number };
  const fwdCache = new Map<number, Map<number, Entry>>();
  const fwdReach = (k: number) => {
    let table = fwdCache.get(k);
    if (!table) {
      table = new Map();
      for (const f of F[k].hyps.slice(0, TOP)) {
        const reach = new Map<number, Reach>();
        reachable(f.state, DEPTH, reach, 8000);
        for (const [key, r] of reach) {
          const cost = f.cost + F[k].offset + r.path.length;
          const prev = table.get(key);
          if (!prev || cost < prev.cost) table.set(key, { f, path: r.path, cost });
        }
      }
      fwdCache.set(k, table);
    }
    return table;
  };
  const bwdCache = new Map<number, { b: Hypothesis; reach: Map<number, Reach> }[]>();
  const bwdReach = (k: number) => {
    let r = bwdCache.get(k);
    if (!r) {
      r = B[k].hyps.slice(0, TOP).map((b) => {
        const reach = new Map<number, Reach>();
        reachable(b.state, DEPTH, reach, 8000);
        return { b, reach };
      });
      bwdCache.set(k, r);
    }
    return r;
  };
  for (let gap = 1; gap <= 10 && !best; gap++) {
    for (let k1 = 0; k1 + gap < N; k1++) {
      const k2 = k1 + gap;
      const table = fwdReach(k1);
      for (const { b, reach } of bwdReach(k2)) {
        for (const [key, rb] of reach) {
          const e = table.get(key);
          if (!e) continue;
          // 前向き: f から e.path、そこから rb.path の逆を逆順に、で b に着く
          const mid = [...e.path, ...rb.path.slice().reverse().map(inverseMove)];
          const cost = e.cost + b.cost + B[k2].offset + rb.path.length;
          if (!best || cost < best.cost) best = { cost, k1, k2, f: e.f, b, mid };
        }
      }
    }
  }
  if (!best) return null;
  const { k1, k2, f, b, mid } = best;
  const head = listOf(f);
  // 橋渡しの手は、隠れていた区間（観測 k1 の後から観測 k2 まで）に等分して置く
  const ta = obs[k1].t;
  const tb = obs[k2].t;
  const middle: DecodedMove[] = mid.map((m, i) => ({ move: m, t0: ta + ((tb - ta) * i) / mid.length, t: ta + ((tb - ta) * (i + 1)) / mid.length, orient: f.orient, inferred: true }));
  const tail = listOf(b)
    .reverse()
    .map((m) => ({ ...m, move: inverseMove(m.move), t0: -m.t, t: -(m.t0 ?? m.t) }));
  return { moves: [...head, ...middle, ...tail], method: "bridge", meetAt: k1, cost: best.cost, reachedEnd: true };
}
