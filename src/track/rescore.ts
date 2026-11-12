// 全フレームで筋書きを採点し直す（精密解析の後段）。
//
// 精密解析の手順（たたき台）を、短い区間（窓）ごとに「別の手順なら全フレームとよりよく合うか」で直す。
// 筋書き = 手の並びと、各手を回していた区間。筋書きが決まれば各フレームでキューブがどの状態であるべきかが決まる:
//   手と手の間 → その間の状態。回している間 → 回している層のマスは見ない（ほかのマスは前の状態のまま）
// フレームの読んだステッカーの ID がその状態と食い違う数を全フレームで足し、手の数を足したものが小さい筋書きを選ぶ。
// 回している区間は、手の並びを決めればフレームの割り当て（動的計画法）で一番合うように決まる。
//
// 観測にまとめずにフレームをそのまま使うので、1〜2 枚しか見えなかった間の状態や、別々のフレームに分かれた証拠も効く。
// 窓の始まりと終わりの状態はたたき台のままにし、その間をつなぐ手の並び（窓の手の数 + extra 手まで）を全部試す。
// カメラも DOM も知らない（Node で動く）。
import { type CubeState, VIEW, applyMove, inverseMove, moveFace } from "../cube/model";
import { stickerIds } from "../cube/stickers";

export interface RescoreFrame {
  t: number;
  faces: { slot: number; ids?: ArrayLike<number> | null }[];
}

export interface RescoreMove {
  move: number;
  start: number;
  end: number;
  orient: number;
  inferred?: boolean;
  rescored?: boolean; // 採点し直しで置き換えた手
}

export interface RescoreOptions {
  window: number; // 1 つの窓に入れるたたき台の手の数
  extra: number; // 窓の中で、たたき台より何手多い並びまで試すか
  moveCost: number; // 手 1 つのコスト
  turnCost: number; // 回している区間に割り当てたフレーム 1 枚のコスト（回している区間を必要以上に長く取らない）
  layerRead: number; // 回しているとしたフレームで、回している層のマスが前か後の状態どおりに読めていたら 1 マスにつき足すコスト
  //                    （手を 1 つ足せば層のマスを見ないで済むので、読み違いを見えない手で片付けないように）
  frameCap: number; // 1 フレームの食い違いの上限（回している途中の読み違い 1 枚に引っ張られない）
  margin: number; // 窓の前後に足すフレームの時間（ms）
  minGain: number; // たたき台よりこれだけ良いときだけ置き換える
  passes: number; // 全体を何回なめるか
}

export const DEFAULT_RESCORE: RescoreOptions = { window: 3, extra: 1, moveCost: 1, turnCost: 0.3, layerRead: 0.5, frameCap: 4, margin: 150, minGain: 1, passes: 2 };

export interface RescoreChange {
  at: number; // たたき台での窓の最初の手の番号
  before: number[];
  after: number[];
  gain: number; // コストの減り
}

const NM = 18;

const keyOf = (s: CubeState) => String.fromCharCode(...s);

// フレームの読み（ID が読めたマスだけ）
interface Compact {
  t: number;
  pos: Int16Array; // slot * 9 + cell
  id: Int16Array;
  orients: number[]; // 照らす姿勢の候補
}

function compact(frames: RescoreFrame[]): Compact[] {
  return frames.map((f) => {
    const pos: number[] = [];
    const id: number[] = [];
    for (const face of f.faces)
      for (let c = 0; c < 9; c++) {
        const x = face.ids?.[c] ?? -1;
        if (x >= 0) {
          pos.push(face.slot * 9 + c);
          id.push(x);
        }
      }
    return { t: f.t, pos: Int16Array.from(pos), id: Int16Array.from(id), orients: [] };
  });
}

// 止まっている区間: 状態 ids（facelet → ステッカー ID）と、1 フレームの食い違いの数（姿勢の候補のうち一番少ないもの）
function stillCost(fr: Compact, ids: Int16Array, cap: number): number {
  let best = Infinity;
  for (const o of fr.orients) {
    let bad = 0;
    const base = o * 54;
    for (let i = 0; i < fr.pos.length && bad < best; i++) if (ids[VIEW[base + fr.pos[i]]] !== fr.id[i]) bad++;
    if (bad < best) best = bad;
  }
  return Math.min(cap, best === Infinity ? 0 : best);
}

// 回している区間: 回す前（状態 before・姿勢 o）と回した後（状態 after・姿勢 o2）でカメラから見て同じステッカーのマスは、そのとおりに
// 読めること。変わるマスは見ない（動いている）が、前か後のとおりに読めたら layerRead ずつ足す（回している途中なら、ずれて・ぶれて
// 読めないことが多い）。姿勢は前後で変わってもよい: 中層回し（M = R L' + x'）・ワイドムーブ（r = L + x）はセンター基準では
// 外側の面の手と持ち替え。どの回し方でも、カメラから見て動かないマスは動かない
function turnCost(fr: Compact, before: Int16Array, after: Int16Array, layerRead: number, cap: number): number {
  let best = Infinity;
  for (const o of fr.orients)
    for (const o2 of fr.orients) {
      let bad = 0;
      for (let i = 0; i < fr.pos.length && bad < best; i++) {
        const x = before[VIEW[o * 54 + fr.pos[i]]];
        const y = after[VIEW[o2 * 54 + fr.pos[i]]];
        if (x === y) {
          if (x !== fr.id[i]) bad++;
        } else if (x === fr.id[i] || y === fr.id[i]) bad += layerRead;
      }
      if (bad < best) best = bad;
    }
  return Math.min(cap, best === Infinity ? 0 : best);
}

// 一番合う姿勢（24 通りから）
function bestOrient(fr: Compact, ids: Int16Array): number {
  let best = { o: 0, bad: Infinity };
  for (let o = 0; o < 24; o++) {
    let bad = 0;
    for (let i = 0; i < fr.pos.length; i++) if (ids[VIEW[o * 54 + fr.pos[i]]] !== fr.id[i]) bad++;
    if (bad < best.bad) best = { o, bad };
  }
  return best.o;
}

// 状態 a から状態 b へ、maxLen 手以内でつなぐ手の並びをすべて（同じ面の手を続けない。両側から探して真ん中で突き合わせる）
export function connect(a: CubeState, b: CubeState, maxLen: number): number[][] {
  const fDepth = Math.ceil(maxLen / 2);
  const bDepth = maxLen - fDepth;
  const fwd = new Map<string, number[][]>();
  const grow = (s: CubeState, seq: number[], depth: number, each: (s: CubeState, seq: number[]) => void, last: number) => {
    each(s, seq);
    if (depth === 0) return;
    for (let m = 0; m < NM; m++) {
      if (last >= 0 && moveFace(m) === moveFace(last)) continue;
      grow(applyMove(s, m), [...seq, m], depth - 1, each, m);
    }
  };
  grow(a, [], fDepth, (s, seq) => {
    const k = keyOf(s);
    const list = fwd.get(k);
    if (list) list.push(seq);
    else fwd.set(k, [seq]);
  }, -1);
  const out = new Map<string, number[]>();
  // 後ろから: b で終わる並びの最後の手を 1 つずつ戻す（tail は実際に回す順）
  const back = (s: CubeState, tail: number[], depth: number) => {
    const heads = fwd.get(keyOf(s));
    if (heads)
      for (const h of heads) {
        if (h.length && tail.length && moveFace(h[h.length - 1]) === moveFace(tail[0])) continue;
        const seq = [...h, ...tail];
        if (seq.length <= maxLen) out.set(seq.join(","), seq);
      }
    if (depth === 0) return;
    for (let m = 0; m < NM; m++) {
      if (tail.length && moveFace(m) === moveFace(tail[0])) continue;
      back(applyMove(s, inverseMove(m)), [m, ...tail], depth - 1);
    }
  };
  back(b, [], bDepth);
  return [...out.values()];
}

interface Scored {
  cost: number;
  starts: number[]; // 手ごとの回し始め（ms）
  ends: number[];
}

// 窓のフレーム frs に、状態の並び states（states[0] → … → states[m]、手 seq）を割り当てたときのコスト（動的計画法）。
// 区間の並び: S0, T1, (J1,) S1, T2, …, Tm, Sm（S = 止まっている、T = 回している）。区間は空でもよい。
// J は、反対の面の手が続くとき（R L' など。中層回し M はセンター基準ではこの 2 手）の、2 つの層を同時に回している区間
// （S_{k-1} から S_{k+1} へ）。同時に回すと 1 層ずつの筋書きではどのフレームも説明できず、余計な手で片付けていた
type Phase = { kind: "S"; k: number } | { kind: "T"; k: number } | { kind: "J"; k: number };
const opposite = (a: number, b: number) => moveFace(a) !== moveFace(b) && moveFace(a) % 3 === moveFace(b) % 3;

function score(frs: Compact[], idsList: Int16Array[], seq: number[], o: RescoreOptions, cache: Map<string, Float32Array>, keys: string[]): Scored {
  const m = seq.length;
  const phases: Phase[] = [{ kind: "S", k: 0 }];
  for (let k = 1; k <= m; k++) {
    phases.push({ kind: "T", k });
    if (k < m && opposite(seq[k - 1], seq[k])) phases.push({ kind: "J", k });
    phases.push({ kind: "S", k });
  }
  const P = phases.length;
  const col = (ph: Phase): Float32Array => {
    const key = ph.kind === "S" ? keys[ph.k] : ph.kind === "T" ? `${keys[ph.k - 1]}|${seq[ph.k - 1]}` : `${keys[ph.k - 1]}|${seq[ph.k - 1]}+${seq[ph.k]}`;
    let c = cache.get(key);
    if (!c) {
      c = new Float32Array(frs.length);
      for (let i = 0; i < frs.length; i++)
        c[i] =
          ph.kind === "S"
            ? stillCost(frs[i], idsList[ph.k], o.frameCap)
            : ph.kind === "T"
              ? turnCost(frs[i], idsList[ph.k - 1], idsList[ph.k], o.layerRead, o.frameCap) + o.turnCost
              : turnCost(frs[i], idsList[ph.k - 1], idsList[ph.k + 1], o.layerRead, o.frameCap) + o.turnCost;
      cache.set(key, c);
    }
    return c;
  };
  const cols = phases.map(col);
  // dp[i][p]: フレーム i を区間 p に割り当てたときの、フレーム 0..i の最小コスト。from[i][p]: フレーム i-1 の区間
  const F = frs.length;
  if (!F) return { cost: o.moveCost * m, starts: seq.map(() => NaN), ends: seq.map(() => NaN) };
  const dp = new Float64Array(F * P).fill(Infinity);
  const from = new Int16Array(F * P);
  for (let p = 0; p < P; p++) dp[p] = cols[p][0];
  for (let i = 1; i < F; i++) {
    let run = Infinity;
    let arg = 0;
    for (let p = 0; p < P; p++) {
      const prev = dp[(i - 1) * P + p];
      if (prev < run) {
        run = prev;
        arg = p;
      }
      dp[i * P + p] = run + cols[p][i];
      from[i * P + p] = arg;
    }
  }
  // 区間は飛ばしてよいので、最初のフレームの前に S0 があり、最後のフレームの後に Sm があるのと同じ（どの区間で始まり・終わってもよい）
  let end = 0;
  for (let p = 1; p < P; p++) if (dp[(F - 1) * P + p] < dp[(F - 1) * P + end]) end = p;
  const phase = new Int16Array(F);
  phase[F - 1] = end;
  for (let i = F - 1; i > 0; i--) phase[i - 1] = from[i * P + phase[i]];
  // 区間 p 以降の最初のフレームと、その前のフレームの中間
  const at = (p: number) => {
    let i = 0;
    while (i < F && phase[i] < p) i++;
    if (i === 0) return frs[0].t;
    if (i === F) return frs[F - 1].t;
    return (frs[i - 1].t + frs[i].t) / 2;
  };
  // 手 k: 回し始め = T_k 以降、回し終わり = S_k 以降（J を使ったら、2 つの手は同じ区間で回している）
  const idx = (kind: string, k: number) => phases.findIndex((ph) => ph.kind === kind && ph.k === k);
  const starts = seq.map((_, k) => at(idx("T", k + 1)));
  const ends = seq.map((_, k) => at(idx("S", k + 1)));
  return { cost: dp[(F - 1) * P + end] + o.moveCost * m, starts, ends };
}

// 同じ面の手をまとめ（U U' → なし・U U → U2）、隣り合う反対の面の手を面の番号の順に並べる（同時に回すと順番は決まらない）
export function canonical(ms: number[]): number[] {
  const merge = (xs: number[]) => {
    const out: number[] = [];
    for (const m of xs) {
      const last = out[out.length - 1];
      if (last !== undefined && moveFace(last) === moveFace(m)) {
        out.pop();
        const amt = ((last % 3) + 1 + (m % 3) + 1) % 4;
        if (amt) out.push(moveFace(m) * 3 + amt - 1);
      } else out.push(m);
    }
    return out;
  };
  let cur = merge(ms);
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i + 1 < cur.length; i++) {
      const a = moveFace(cur[i]);
      const b = moveFace(cur[i + 1]);
      if (a !== b && a % 3 === b % 3 && a > b) {
        [cur[i], cur[i + 1]] = [cur[i + 1], cur[i]];
        changed = true;
      }
    }
    if (changed) cur = merge(cur);
  }
  return cur;
}

export function rescore(frames: RescoreFrame[], start: CubeState, moves: RescoreMove[], options: Partial<RescoreOptions> = {}): { moves: RescoreMove[]; changes: RescoreChange[] } {
  const o = { ...DEFAULT_RESCORE, ...options };
  const frs = compact(frames.slice().sort((a, b) => a.t - b.t)).filter((f) => f.pos.length > 0);
  let seq = moves.map((m) => ({ ...m }));
  const changes: RescoreChange[] = [];
  // 姿勢の候補: たたき台でそのフレームの時刻の状態に一番合う姿勢と、前後の手の姿勢
  {
    let st: CubeState = Uint8Array.from(start);
    let k = 0;
    for (const fr of frs) {
      while (k < seq.length && seq[k].end <= fr.t) st = applyMove(st, seq[k++].move);
      const set = new Set<number>([bestOrient(fr, stickerIds(st))]);
      for (let j = Math.max(0, k - 2); j < Math.min(seq.length, k + 2); j++) set.add(seq[j].orient);
      fr.orients = [...set];
    }
  }
  // 同じ所を何度も置き換えない（重なった窓が A → B → A と行き来し、手が増え続けることがあった）。置き換えた手の回し始めの時刻で数える
  const touched = new Map<number, number>();
  const bucket = (t: number) => Math.round(t / 100);
  const limit = moves.length * 2;
  for (let pass = 0; pass < o.passes; pass++) {
    let changed = false;
    for (let a = 0; a < seq.length && changes.length < limit; a++) {
      const K = Math.min(o.window, seq.length - a);
      const states: CubeState[] = [Uint8Array.from(start)];
      for (let i = 0; i < a + K; i++) states.push(applyMove(states[i], seq[i].move));
      const sa = states[a];
      const sb = states[a + K];
      const win = seq.slice(a, a + K);
      // 窓の前後の手も（動かさずに）一緒に採点する: 前後の手を回している間のフレームを、どの並びでもその手の回している区間に
      // 割り当てられるように（窓の端で切ると、それらのフレームが窓の始まり・終わりの状態と食い違い、余計な手を足して回している区間で
      // 片付ける並びが得をしていた）
      const prev = a > 0 ? seq[a - 1] : null;
      const next = a + K < seq.length ? seq[a + K] : null;
      const ctx = [prev, ...win, next].filter((m): m is RescoreMove => !!m);
      const t0 = Math.min(...ctx.map((m) => m.start)) - o.margin;
      const t1 = Math.max(...ctx.map((m) => m.end)) + o.margin;
      const wf = frs.filter((f) => f.t >= t0 && f.t <= t1);
      const cache = new Map<string, Float32Array>();
      const s0 = prev ? states[a - 1] : sa;
      const evalSeq = (s: number[]) => {
        const full = [...(prev ? [prev.move] : []), ...s, ...(next ? [next.move] : [])];
        const sts = [s0];
        for (const m of full) sts.push(applyMove(sts[sts.length - 1], m));
        const r = score(wf, sts.map((x) => stickerIds(x)), full, o, cache, sts.map(keyOf));
        const k = prev ? 1 : 0;
        return { cost: r.cost, starts: r.starts.slice(k, k + s.length), ends: r.ends.slice(k, k + s.length) };
      };
      const base = evalSeq(win.map((m) => m.move));
      let best: { seq: number[]; r: Scored } | null = null;
      for (const cand of connect(sa, sb, K + o.extra)) {
        const r = evalSeq(cand);
        if (!best || r.cost < best.r.cost) best = { seq: cand, r };
      }
      if (!best || best.r.cost > base.cost - o.minGain) continue;
      if (best.seq.join() === win.map((m) => m.move).join()) continue;
      // 同じ面の手をまとめ、反対の面の手の順番をそろえると同じ並び（中層回しの分け方が違うだけ）なら置き換えない（手が増えるだけ）
      if (canonical(best.seq).join() === canonical(win.map((m) => m.move)).join()) continue;
      const b0 = bucket(win[0].start);
      if ((touched.get(b0) ?? 0) >= 2) continue;
      touched.set(b0, (touched.get(b0) ?? 0) + 1);
      const orient = win[0].orient;
      const repl: RescoreMove[] = best.seq.map((mv, k) => ({ move: mv, start: best!.r.starts[k], end: best!.r.ends[k], orient, rescored: true }));
      changes.push({ at: a, before: win.map((m) => m.move), after: best.seq, gain: base.cost - best.r.cost });
      seq = [...seq.slice(0, a), ...repl, ...seq.slice(a + K)];
      changed = true;
    }
    if (!changed) break;
  }
  return { moves: seq, changes };
}
