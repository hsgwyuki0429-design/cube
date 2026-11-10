// ソルブ後の手順の再構成（時間をかけてよい、正確さ優先の経路）。リアルタイムの追跡とは別に動かす。
//
// 始まりの状態（スクランブル後）と終わりの状態（完成）の両方が分かっているので、
//   前向き: 始まりの状態から、観測を順に説明する仮説をたくさん（ビーム）持って進める
//   後ろ向き: 終わりの状態から、観測を逆順に説明する仮説を持って戻る（手は逆向きになる）
// の 2 本を走らせ、途中のどこかの観測で「同じ状態・同じ姿勢」になる仮説どうしを、合計のコストが
// 最も小さくなる所でつなぐ。指で隠れて途中がしばらく分からなくても、前後の両側から辻褄の合う道を選べる。
// つながらなければ、前向きの結果を終わりの状態に合わせる（finish）。
import { hash53 } from "../cube/hash";
import { type CubeState, MOVE_SRC, NUM_MOVES, inverseMove, redundantAfter, statesEqual } from "../cube/model";
import { type DecoderOptions, type Hypothesis, MoveDecoder } from "./decoder";
import { movePrior } from "./prior";
import type { DecodedMove, Observation } from "./types";

export interface OfflineOptions {
  decoder: Partial<DecoderOptions>;
  personal?: number[][]; // 自分のソルブの手順（手順の知識に加える）
  bridge?: boolean; // つながらないときに隠れた区間を橋渡しするか（既定 true。軽い解析ではしない）
}

export const DEFAULT_OFFLINE: OfflineOptions = {
  // 見失いからの復帰探索はしない（前後からつなぐ・橋渡しで補う方が正確で速い）
  decoder: { beamWidth: 64, maxMovesPerStep: 3, lostAfter: 1000 },
};

export interface OfflineResult {
  moves: DecodedMove[];
  method: "meet" | "bridge" | "backward" | "forward-finish" | "forward";
  // method が backward のとき: 後ろ向きにたどり着いた始まりの状態（渡された始まりの状態とは違う: スクランブルを間違えて回していた）
  startState?: CubeState;
  // 終わりに届かなかったとき: 後ろ向きが終わりから追えていた分の手順（時刻の順。タイムの終わりを決めるのに使う）
  tail?: DecodedMove[];
  meetAt: number; // つないだ観測の番号（meet のとき）
  cost: number;
  reachedEnd: boolean;
}

interface Snapshot {
  hyps: Hypothesis[];
  offset: number;
}
const NO_SNAPSHOT: Snapshot = { hyps: [], offset: Infinity }; // 後ろ向きを打ち切った先の観測
// 後ろ向きの打ち切り: 前向き・後ろ向きの一番安い仮説のコストの和が、見つかっているつなぎ方のコストをこれだけ超えたら
// （観測 10 個分ほどの見失い。1 マスの矛盾 1.5・見失った観測は 3 以上）
const STOP_MARGIN = 30;

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

// 前向きの再構成を、観測が出るたびに進めておく（精密解析はソルブ中から観測を出すので、止めた後は後ろ向きとつなぐだけで済む）。
// 観測は追加した後で書き換わらないこと。decodeOffline に渡すと、同じ観測をすべて通してあればそれを使う
export class OfflineForward {
  readonly fwd: MoveDecoder;
  readonly F: Snapshot[] = [];
  private seen: Observation[] = [];
  constructor(
    readonly start: CubeState,
    readonly options: OfflineOptions = DEFAULT_OFFLINE,
  ) {
    this.fwd = new MoveDecoder(start, options.decoder);
    if (options.personal?.length && this.fwd.prior) this.fwd.prior = movePrior(options.personal);
  }
  feed(o: Observation): void {
    if (!o.faces.length) return;
    this.fwd.observe(o);
    this.F.push({ hyps: [...this.fwd.hypotheses()], offset: this.fwd.costOffset });
    this.seen.push(o);
  }
  // valid と同じ観測をすべて通したか
  covers(valid: Observation[], start: CubeState): boolean {
    return statesEqual(start, this.start) && valid.length === this.seen.length && valid.every((o, i) => o === this.seen[i]);
  }
}

export function decodeOffline(obs: Observation[], start: CubeState, end: CubeState | null, lastT: number, options: OfflineOptions = DEFAULT_OFFLINE, pre?: OfflineForward): OfflineResult {
  const valid = obs.filter((o) => o.faces.length);
  let fwd: MoveDecoder;
  let F: Snapshot[];
  if (pre?.covers(valid, start)) {
    fwd = pre.fwd;
    F = pre.F;
  } else {
    const p = new OfflineForward(start, options);
    for (const o of valid) p.feed(o);
    fwd = p.fwd;
    F = p.F;
  }
  const forwardBest = (): OfflineResult => {
    const moves = fwd.bestMoves();
    return { moves, method: "forward", meetAt: -1, cost: fwd.costOffset, reachedEnd: end ? statesEqual(fwd.best().state, end) : true };
  };
  if (!end || !valid.length) return forwardBest();

  const bwd = new MoveDecoder(end, options.decoder);
  bwd.prior = fwd.prior;
  const rev = reversedObservations(valid, lastT);
  const B: Snapshot[] = new Array(valid.length).fill(NO_SNAPSHOT);
  // 後ろ向きに 1 観測ずつ進めながらつなぐ: 観測 k の時点で同じ状態・姿勢の仮説（観測 k のコストは両方に入っているので 1 回引く）。
  // 合計のコストが最小の所（同じなら早い観測）
  let best: { cost: number; k: number; f: Hypothesis; b: Hypothesis } | null = null;
  for (let j = 0; j < rev.length; j++) {
    const k = valid.length - 1 - j;
    bwd.observe(rev[j]);
    B[k] = { hyps: [...bwd.hypotheses()], offset: bwd.costOffset };
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
      if (!best || cost < best.cost || (cost === best.cost && k < best.k)) best = { cost, k, f, b };
    }
    // つながる所が見つかっていて、ここでつないでもそれよりずっと高くつく（後ろ向きが見失っている）なら、後ろ向きを打ち切る。
    // 見失った後ろ向きは観測ごとに矛盾を払い続け、候補も深く探すので遅い: 実物のソルブ（観測 309）で、後ろ向きは終わりの 60 観測の
    // 後ずっと見失ったまま残りの 250 観測を探していた（解き直しの時間のほとんど）
    if (best && F[k].offset + B[k].offset > best.cost + STOP_MARGIN) break;
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
  // 後ろ向きの手は、逆の手を逆の順に。時刻も反転する
  const backMoves = (b: Hypothesis) =>
    listOf(b)
      .reverse()
      .map((m) => ({ ...m, move: inverseMove(m.move), t0: -m.t, t: -(m.t0 ?? m.t) }));
  // 後ろ向きだけで最初の観測まで追えていた: 始まりの状態が渡されたものと違う（スクランブルを間違えて回した・案内と違う状態から
  // 始めた）。前向きは最初から合わず、どこでもつながらないが、完成から後ろ向きにたどった手順はソルブの全部になっている。
  // 見失い（矛盾 LOST_COST 以上の観測が 4 つ続く）がどこにもないこと
  const lostAt = (k: number) => (B[k].hyps[0]?.obsCost ?? Infinity) >= LOST_COST;
  let lostRun = false;
  for (let k = 0; k + 3 < valid.length && !lostRun; k++) lostRun = lostAt(k) && lostAt(k + 1) && lostAt(k + 2) && lostAt(k + 3);
  const b0 = B[0].hyps[0];
  if (b0 && valid.length >= 8 && !lostRun && !lostAt(0))
    return { moves: backMoves(b0), method: "backward", meetAt: -1, cost: b0.cost + B[0].offset, reachedEnd: true, startState: Uint8Array.from(b0.state) };
  // 前後どちらも、隠れていた同じ区間で見失った: 隠れる前の前向きの仮説と、隠れた後の後ろ向きの仮説を短い手順でつなぐ
  const bridged = options.bridge === false ? null : bridge(F, B, valid);
  if (bridged) return bridged;
  // それでもつながらない: 前向きの結果を、終わりの状態にたどり着くよう補う
  const fixed = finishDeep(fwd, end, lastT);
  if (fixed) return { moves: fixed, method: "forward-finish", meetAt: -1, cost: fwd.costOffset, reachedEnd: true };
  // 届かない: 後ろ向きが終わりから続けて追えていた所までの手順を付ける（タイムの終わりは決められる）
  let kT = valid.length;
  while (kT > 0 && !lostAt(kT - 1)) kT--;
  const tb = kT < valid.length ? B[kT].hyps[0] : undefined;
  return { ...forwardBest(), ...(tb ? { tail: backMoves(tb) } : {}) };
}

// 前向きの有力な仮説から、終わりの状態に届く手を足す（2 手で届かなければ 3 手・4 手まで。足した手は inferred）。
// 時間がかかってもよいので、つながらないまま結果を出さないより、見えなかった手を足して完成までつなぐ
export function finishDeep(dec: MoveDecoder, end: CubeState, t: number): DecodedMove[] | null {
  for (const depth of [2, 3, 4]) {
    const r = dec.finish(end, t, depth, depth > 2 ? 4 : 6);
    if (r) return r;
  }
  return null;
}

// ---- 隠れた区間の橋渡し ----

// 起点の状態から DEPTH 手以内で届く状態（同じ面の連続・反対面の並べ替えは片方だけ）。状態のハッシュの昇順に並べ、
// 手順は 1 つの数（19 進で 1 手ずつ、手 + 1）にして持つ（配列やオブジェクトを状態の数だけ作るとメモリが膨らむ）
interface Reach {
  keys: Float64Array;
  codes: Uint16Array;
}

const pathLength = (code: number): number => {
  let n = 0;
  for (; code > 0; code = Math.floor(code / 19)) n++;
  return n;
};
const pathOf = (code: number): number[] => {
  const out: number[] = [];
  for (; code > 0; code = Math.floor(code / 19)) out.push((code % 19) - 1);
  return out.reverse();
};

function reachable(start: Uint8Array, depth: number): Reach {
  const best = new Map<number, number>(); // 状態 → 一番短い手順
  const lens = new Map<number, number>();
  const visit = (s: Uint8Array, code: number, len: number, last: number) => {
    const k = hash53(s);
    const prev = lens.get(k);
    if (prev === undefined || prev > len) {
      best.set(k, code);
      lens.set(k, len);
    }
    if (len >= depth) return;
    const next = new Uint8Array(54);
    for (let m = 0; m < NUM_MOVES; m++) {
      if (redundantAfter(last, m)) continue;
      const p = MOVE_SRC[m];
      for (let i = 0; i < 54; i++) next[i] = s[p[i]];
      visit(next, code * 19 + m + 1, len + 1, m);
    }
  };
  visit(start, 0, 0, -1);
  const keys = Float64Array.from(best.keys()).sort();
  const codes = new Uint16Array(keys.length);
  for (let i = 0; i < keys.length; i++) codes[i] = best.get(keys[i])!;
  return { keys, codes };
}

// 観測 1 つの上位の仮説から DEPTH 手で届く状態の表（ハッシュの昇順。同じ状態なら仮説のコスト + 手数が小さい方）
interface Table {
  keys: Float64Array;
  cost: Float64Array; // 仮説のコスト + 観測のオフセット + 手数
  hyp: Uint8Array; // 上位の何番目の仮説か
  code: Uint16Array;
}

function tableOf(snap: Snapshot, top: number, reachOf: (s: Uint8Array) => Reach): Table {
  const hyps = snap.hyps.slice(0, top);
  const rs = hyps.map((h) => reachOf(h.state));
  const total = rs.reduce((a, r) => a + r.keys.length, 0);
  const t: Table = { keys: new Float64Array(total), cost: new Float64Array(total), hyp: new Uint8Array(total), code: new Uint16Array(total) };
  // 仮説ごとの昇順の並びを 1 本にまとめる（いちばん小さい先頭を選び続ける）
  const at = new Int32Array(rs.length);
  let n = 0;
  for (;;) {
    let pick = -1;
    let key = Infinity;
    for (let i = 0; i < rs.length; i++) {
      if (at[i] < rs[i].keys.length && rs[i].keys[at[i]] < key) {
        key = rs[i].keys[at[i]];
        pick = i;
      }
    }
    if (pick < 0) break;
    const code = rs[pick].codes[at[pick]++];
    const cost = hyps[pick].cost + snap.offset + pathLength(code);
    if (n > 0 && t.keys[n - 1] === key) {
      if (cost < t.cost[n - 1]) {
        t.cost[n - 1] = cost;
        t.hyp[n - 1] = pick;
        t.code[n - 1] = code;
      }
      continue;
    }
    t.keys[n] = key;
    t.cost[n] = cost;
    t.hyp[n] = pick;
    t.code[n] = code;
    n++;
  }
  return { keys: t.keys.subarray(0, n), cost: t.cost.subarray(0, n), hyp: t.hyp.subarray(0, n), code: t.code.subarray(0, n) };
}

// 隠れる前の前向きの上位と隠れた後の後ろ向きの上位を、3 手 + 3 手で届く状態の突き合わせでつなぐ（間が 10 観測まで。
// 間の短い方を優先し、同じ間ならコストの小さい方）。表は前向きの直近 10 観測分と、後ろ向きの 1 観測分だけを持つ
// （以前は全観測の表を持ち続け、観測が数百あると数 GB になって iPhone でタブごと落ちた）。届く状態は状態ごとに覚えておく（直近の分だけ）。
// 探すのは、まず前向きが観測と合わなくなった所と後ろ向きが合わなくなった所の間（隠れていた区間の前後）。見つからなければ残りを、
// 時間の上限（BRIDGE_MS）まで
const BRIDGE_MS = 10000; // 結果を出すことを優先して長めに（表は直近の分だけなのでメモリは増えない）。この間は進み具合を知らせられないので、
// 呼ぶ側の「止まった」の見張り（controller.endAnalysis の STALL_MS）より十分短く
const LOST_COST = 3; // 観測の矛盾がこれ以上の観測が 3 つ続いたら見失っている

function bridge(F: Snapshot[], B: Snapshot[], obs: Observation[]): OfflineResult | null {
  const N = obs.length;
  const TOP = 16;
  const DEPTH = 3;
  const GAP = 10;
  const deadline = performance.now() + BRIDGE_MS;
  const cache = new Map<number, Reach>();
  const reachOf = (s: Uint8Array): Reach => {
    const h = hash53(s);
    let r = cache.get(h);
    if (r) {
      cache.delete(h);
      cache.set(h, r); // 最近使ったものを後ろへ
      return r;
    }
    r = reachable(s, DEPTH);
    cache.set(h, r);
    if (cache.size > 96) cache.delete(cache.keys().next().value!);
    return r;
  };
  type Best = { gap: number; cost: number; k1: number; k2: number; fi: number; fc: number; bi: number; bc: number };
  let best = null as Best | null;
  // k2 が lo..hi の範囲を探す
  const scan = (lo: number, hi: number) => {
    const window = new Map<number, Table>();
    for (let k = Math.max(0, lo - GAP); k < lo - 1; k++) window.set(k, tableOf(F[k], TOP, reachOf));
    for (let k2 = Math.max(1, lo); k2 <= Math.min(hi, N - 1); k2++) {
      if (performance.now() > deadline) return;
      window.set(k2 - 1, tableOf(F[k2 - 1], TOP, reachOf));
      window.delete(k2 - 1 - GAP);
      const bt = tableOf(B[k2], TOP, reachOf);
      for (let k1 = k2 - 1; k1 >= Math.max(0, k2 - GAP); k1--) {
        const gap = k2 - k1;
        if (best && gap > best.gap) break;
        const ft = window.get(k1)!;
        // 2 つの昇順の並びの突き合わせ
        let i = 0;
        let j = 0;
        while (i < ft.keys.length && j < bt.keys.length) {
          const a = ft.keys[i];
          const b = bt.keys[j];
          if (a < b) i++;
          else if (a > b) j++;
          else {
            // 前向き: 仮説 f から f の手順、そこから b の手順の逆を逆順に、で b に着く（どちらの表のコストもオフセット込み）
            const cost = ft.cost[i] + bt.cost[j];
            if (!best || gap < best.gap || cost < best.cost) best = { gap, cost, k1, k2, fi: ft.hyp[i], fc: ft.code[i], bi: bt.hyp[j], bc: bt.code[j] };
            i++;
            j++;
          }
        }
      }
    }
  };
  const bad = (S: Snapshot[], k: number) => k >= 0 && k < N && (S[k].hyps[0]?.obsCost ?? Infinity) >= LOST_COST;
  let kA = -1; // 前向きが見失い始めた観測
  for (let k = 0; k < N && kA < 0; k++) if (bad(F, k) && bad(F, k + 1) && bad(F, k + 2)) kA = k;
  let kB = -1; // 後ろ向きが（時間を戻る向きに）見失い始めた観測
  for (let k = N - 1; k >= 0 && kB < 0; k--) if (bad(B, k) && bad(B, k - 1) && bad(B, k - 2)) kB = k;
  if (kA >= 0 && kB >= 0) {
    const lo = Math.max(1, Math.min(kA, kB) - GAP);
    const hi = Math.min(N - 1, Math.max(kA, kB) + GAP);
    scan(lo, hi);
    if (!best) scan(1, lo + GAP);
    if (!best) scan(hi - GAP, N - 1);
  } else scan(1, N - 1);
  if (!best) return null;
  const { k1, k2 } = best;
  const f = F[k1].hyps[best.fi];
  const b = B[k2].hyps[best.bi];
  const mid = [...pathOf(best.fc), ...pathOf(best.bc).reverse().map(inverseMove)];
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
