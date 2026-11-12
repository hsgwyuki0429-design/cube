// 確かな所から埋める手順の再構成（精密解析）。
//
// 観測にまとめて左から 1 本ずつ進める（decodeOffline）代わりに、フレームの読みを「どのステッカーがいつどのマスに見えたか」の
// 並びにして、読みが食い違わずに続いた区間（止まっていた区間 = アンカー）ごとに、そこで見えたステッカーの位置を確かな手がかりにする。
// 隣り合うアンカーの間は、前のアンカーの状態から前向きに、次のアンカーで見えたステッカーの位置から後ろ向きに探して、
// 見えたステッカーの位置だけで突き合わせる（両側から 4 手ずつ = 8 手まで）。見つかった手順は、間のフレームすべてで採点する
// （止まっている区間は状態どおりに読めること、回している区間はカメラから見て変わらないマスだけ。rescore.ts と同じ見方）。
// アンカーごとに有力な状態を数個残すので、1 か所で取り違えても次のアンカーで外れた候補が落ちる（誤りが先へ伝わらない）。
// つながらないアンカーは弱いとみて飛ばし、その読みは間のフレームとして使う。最後は終わりの状態（完成）とつなぐ。
//
// カメラも DOM も知らない（Node で動く）。
import { type CubeState, MOVE_DEST, NUM_MOVES, VIEW, inverseMove, moveFace, redundantAfter } from "../cube/model";
import { stickerIds } from "../cube/stickers";
import type { DecodedMove } from "./types";

export interface Sighting {
  t: number;
  // w: マスごとの読みの確からしさ（FrameReading.weight）。マーカーを直接読んだマスは 0.9〜1、前のフレームから引き継いだ ID は 0.7 以下
  faces: { slot: number; ids?: ArrayLike<number> | null; w?: ArrayLike<number> | null }[];
}

export interface AnchorOptions {
  minIds: number; // アンカーにする、見えたステッカー（センター以外）の数
  minWeak: number; // アンカーの間がつながらないとき足場に使う、弱い読みの区間の見えたステッカーの数
  minWeight: number; // 使う読みの確からしさ（引き継いだ ID・はっきりしない読みは使わない: 静止しているインスペクション中でも、
  //                    持ち替えをまたいで引き継いだ ID が正解の状態と食い違っていた）
  maxDepth: number; // 隣り合うアンカーの間の手の数の上限（両側から探す）
  tolerance: number; // 1 つのつなぎ（アンカーの間のフレーム）で許す読みの食い違い（これを超える候補だけを落とす）。2 では原画質の
  //                   ソルブでも正しい道が途中で落ちた（回している途中の読み・まれな読み違い）。4 で最後までつながる
  maxSet: number; // アンカーごとに残す状態の上限（超えたら、その先は決められないとする。上位だけ残すことはしない）
  candidates: number; // 1 つのつなぎで採点する手順の数の上限（超えたら決められないとする）
  connectMs: number; // 1 つのつなぎに使う時間の上限（超えたら決められないとする）
  passMs: number; // 片道に使う時間の上限
  moveCost: number;
  oppositeCost: number; // 反対の面の手の直後の手（中層回しの 2 手目）のコスト
  rotationCost: number; // 持ち替え（姿勢が変わる）のコスト
  turnFrameCost: number; // 回している区間に割り当てたフレーム 1 枚のコスト
  layerRead: number; // 回しているとしたフレームで、動くマスが前か後のとおりに読めていたら 1 マスにつき
  frameCap: number; // 1 フレームの食い違いの上限
  maxSkip: number; // 続けて飛ばしてよいアンカーの数
  skipCost: number; // アンカーを飛ばす（動いていないとみて、読み違いはフレームの食い違いで払う）ときに足すコスト
  msPerMove: number; // 間の時間から手の数の上限を決める（間 / msPerMove + 2 手まで）
  tick?: () => void;
  // 調べ用: アンカーごとに、つないだ後の仮説（状態・姿勢・コスト・足した手）を渡す
  onAnchor?: (info: { t0: number; t1: number; stickers: number; orients: number[] | null; connected: boolean; hyps: { state: CubeState; orient: number; cost: number; moves: number[] }[] }) => void;
}

export const DEFAULT_ANCHORS: AnchorOptions = {
  minIds: 5,
  minWeak: 2,
  minWeight: 0.85,
  maxDepth: 8,
  tolerance: 4,
  maxSet: 512,
  candidates: 4000,
  connectMs: 4000,
  passMs: 120000,
  moveCost: 1,
  oppositeCost: 0.5,
  rotationCost: 0.5,
  turnFrameCost: 0.3,
  layerRead: 0.5,
  frameCap: 4,
  maxSkip: 4,
  skipCost: 1,
  msPerMove: 60,
};

export interface AnchorResult {
  moves: DecodedMove[];
  reachedEnd: boolean;
  cost: number;
  anchors: number; // アンカーの数
  skipped: number;
  method?: "meet" | "bridge" | "forward";
  uncertain?: boolean; // 1 通りに決まらなかった所がある（その手は inferred）
  forwardTo?: number | null; // 前向きで決められた最後のアンカーの時刻
  reason?: string; // 前向きが止まった理由
}

// ---- フレーム ----

interface Frame {
  t: number;
  pos: Int16Array; // slot * 9 + cell
  id: Int16Array;
  centers: number[] | null; // 読めたセンターに合う姿勢（センターが読めなければ null）
}

const ALL_ORIENTS = Array.from({ length: 24 }, (_, o) => o);
const isCenter = (id: number) => id % 9 === 4;

function centerOrients(pos: number[], id: number[]): number[] | null {
  const cs: [number, number][] = [];
  for (let i = 0; i < pos.length; i++) if (isCenter(id[i]) && pos[i] % 9 === 4) cs.push([pos[i], id[i]]);
  if (!cs.length) return null;
  return ALL_ORIENTS.filter((o) => cs.every(([p, x]) => VIEW[o * 54 + p] === x));
}

function toFrames(sightings: Sighting[], minWeight = DEFAULT_ANCHORS.minWeight): Frame[] {
  const out: Frame[] = [];
  for (const s of sightings) {
    const pos: number[] = [];
    const id: number[] = [];
    for (const f of s.faces)
      for (let c = 0; c < 9; c++) {
        const x = f.ids?.[c] ?? -1;
        if (x >= 0 && (f.w?.[c] ?? 1) >= minWeight) {
          pos.push(f.slot * 9 + c);
          id.push(x);
        }
      }
    if (!pos.length) continue;
    const centers = centerOrients(pos, id);
    out.push({ t: s.t, pos: Int16Array.from(pos), id: Int16Array.from(id), centers: centers && centers.length ? centers : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---- アンカー: 読みが食い違わずに続いた区間 ----

interface Anchor {
  first: number; // フレームの番号
  last: number;
  t0: number;
  t1: number;
  pos: number[]; // 見えたステッカー（センター以外）のマス
  id: number[];
  orients: number[] | null;
}

const STRETCH_GAP_MS = 150;

function anchorsOf(frames: Frame[], minIds: number): Anchor[] {
  const out: Anchor[] = [];
  let cur: { first: number; last: number; map: Map<number, number>; where: Map<number, number>; orients: number[] | null } | null = null;
  const close = () => {
    if (!cur) return;
    const pos: number[] = [];
    const id: number[] = [];
    for (const [p, x] of cur.map) if (!isCenter(x)) (pos.push(p), id.push(x));
    if (pos.length >= minIds) out.push({ first: cur.first, last: cur.last, t0: frames[cur.first].t, t1: frames[cur.last].t, pos, id, orients: cur.orients });
    cur = null;
  };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let ok = !!cur && f.t - frames[cur.last].t <= STRETCH_GAP_MS;
    if (ok && cur) {
      for (let k = 0; k < f.pos.length && ok; k++) {
        const had = cur.map.get(f.pos[k]);
        if (had !== undefined && had !== f.id[k]) ok = false;
        const at = cur.where.get(f.id[k]);
        if (at !== undefined && at !== f.pos[k]) ok = false;
      }
      if (ok && cur.orients && f.centers) ok = cur.orients.some((o) => f.centers!.includes(o));
      // 前のフレームと半分以上同じマスを同じように読めていること（回した層のマスが、回す前と後で別のマスだけ読めていると、
      // 食い違いが見えないまま前後の状態が混ざる）
      if (ok) {
        const prev = frames[cur.last];
        let same = 0;
        for (let k = 0; k < f.pos.length; k++) for (let j = 0; j < prev.pos.length; j++) if (prev.pos[j] === f.pos[k] && prev.id[j] === f.id[k]) same++;
        if (same * 2 < Math.min(f.pos.length, prev.pos.length)) ok = false;
      }
    }
    if (!ok || !cur) {
      close();
      cur = { first: i, last: i, map: new Map(), where: new Map(), orients: f.centers };
    } else {
      cur.last = i;
      if (f.centers) cur.orients = cur.orients ? cur.orients.filter((o) => f.centers!.includes(o)) : f.centers;
    }
    for (let k = 0; k < f.pos.length; k++) {
      cur.map.set(f.pos[k], f.id[k]);
      cur.where.set(f.id[k], f.pos[k]);
    }
  }
  close();
  return out;
}

// ---- 状態 = ステッカーの位置 ----

// P[x] = ステッカー x のいる facelet
function positionsOf(state: CubeState): Uint8Array {
  const ids = stickerIds(state);
  const p = new Uint8Array(54);
  for (let f = 0; f < 54; f++) p[ids[f]] = f;
  return p;
}
function stateOf(p: Uint8Array): CubeState {
  const s = new Uint8Array(54);
  for (let x = 0; x < 54; x++) s[p[x]] = Math.floor(x / 9);
  return s;
}
function idsOf(p: Uint8Array): Int16Array {
  const ids = new Int16Array(54);
  for (let x = 0; x < 54; x++) ids[p[x]] = x;
  return ids;
}
function applyPos(p: Uint8Array, m: number): Uint8Array {
  const d = MOVE_DEST[m];
  const q = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) q[i] = d[p[i]];
  return q;
}
const tupleKey = (t: Uint8Array) => String.fromCharCode(...t);

// 位置の組 from（ステッカー数個の位置）から、組 to に送る手順を、短いものから集める（両側から探して突き合わせる）。
// 長さ L の手順は、前向き ceil(L/2) 手 + 後ろ向き floor(L/2) 手。深さは必要になってから作る（たいていのつなぎは 0〜2 手）。
// 見つかった一番短い長さと、その 1 手長いものまで
class Layers {
  private maps: Map<string, number[][]>[] = [];
  private frontier: { p: Uint8Array; seq: number[] }[];
  constructor(
    start: Uint8Array,
    private inverse: boolean,
  ) {
    this.frontier = [{ p: start, seq: [] }];
    this.push();
  }
  private push(): void {
    const m = new Map<string, number[][]>();
    for (const n of this.frontier) {
      const k = tupleKey(n.p);
      const l = m.get(k);
      if (l) {
        if (l.length < 8) l.push(n.seq);
      } else m.set(k, [n.seq]);
    }
    this.maps.push(m);
  }
  at(d: number): Map<string, number[][]> {
    while (this.maps.length <= d) {
      const next: { p: Uint8Array; seq: number[] }[] = [];
      for (const n of this.frontier) {
        // 前向き: 最後の手の後に足す。後ろ向き: 最初の手の前に足す（逆の手で戻る）
        const edge = n.seq.length ? (this.inverse ? n.seq[0] : n.seq[n.seq.length - 1]) : -1;
        for (let mv = 0; mv < NUM_MOVES; mv++) {
          if (edge >= 0 && (this.inverse ? redundantAfter(mv, edge) : redundantAfter(edge, mv))) continue;
          next.push({ p: applyPos(n.p, this.inverse ? inverseMove(mv) : mv), seq: this.inverse ? [mv, ...n.seq] : [...n.seq, mv] });
        }
      }
      this.frontier = next;
      this.push();
    }
    return this.maps[d];
  }
}

// 長さちょうど L で、組 F（前向き）から組 to（後ろ向き B）に着く手順。limit を超えたら null（打ち切らない）
function sequencesOfLength(F: Layers, B: Layers, L: number, limit: number): number[][] | null {
  const f = Math.min(4, Math.ceil(L / 2));
  const b = L - f;
  if (b > 4) return [];
  const fm = F.at(f);
  const bm = B.at(b);
  const found: number[][] = [];
  // 小さい方の表を回す
  const [small, large, smallIsF] = fm.size <= bm.size ? [fm, bm, true] : [bm, fm, false];
  for (const [k, xs] of small) {
    const ys = large.get(k);
    if (!ys) continue;
    for (const x of xs)
      for (const y of ys) {
        const [s, tl] = smallIsF ? [x, y] : [y, x];
        if (s.length && tl.length && moveFace(s[s.length - 1]) === moveFace(tl[0])) continue;
        found.push([...s, ...tl]);
        if (found.length > limit) return null;
      }
  }
  return found;
}

function connectTuples(F: Layers, to: Uint8Array, maxDepth: number, limit: number, deadline: number): { seqs: number[][]; len: number; overflow: boolean } {
  const B = new Layers(to, true);
  const found: number[][] = [];
  let best = -1;
  for (let L = 0; L <= maxDepth; L++) {
    if (best >= 0 && L > best + 1) break;
    if (performance.now() > deadline) break;
    const f = Math.ceil(L / 2);
    const fm = F.at(f);
    const bm = B.at(L - f);
    for (const [k, seqs] of fm) {
      const tails = bm.get(k);
      if (!tails) continue;
      for (const s of seqs)
        for (const tl of tails) {
          if (s.length && tl.length && moveFace(s[s.length - 1]) === moveFace(tl[0])) continue;
          found.push([...s, ...tl]);
          // 上限を超えたら打ち切らずに「多すぎる」と返す（呼ぶ側はその区間を決められないとする）
          if (found.length > limit) return { seqs: [], len: best < 0 ? L : best, overflow: true };
        }
    }
    if (found.length && best < 0) best = L;
  }
  return { seqs: found, len: best, overflow: performance.now() > deadline };
}

// ---- 間のフレームでの採点（rescore.ts と同じ区間のモデル） ----

function stillCost(fr: Frame, ids: Int16Array, orients: number[], cap: number): number {
  let best = Infinity;
  for (const o of orients) {
    let bad = 0;
    for (let i = 0; i < fr.pos.length && bad < best; i++) if (ids[VIEW[o * 54 + fr.pos[i]]] !== fr.id[i]) bad++;
    if (bad < best) best = bad;
  }
  return Math.min(cap, best);
}

function turnCost(fr: Frame, before: Int16Array, after: Int16Array, orients: number[], layerRead: number, cap: number): number {
  let best = Infinity;
  for (const o of orients)
    for (const o2 of orients) {
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
  return Math.min(cap, best);
}

interface Scored {
  cost: number;
  starts: number[];
  ends: number[];
}

// フレーム frs に、ステッカーの位置の並び（手 seq で移る）を割り当てたときのコスト。区間: S0, T1, S1, …, Tm, Sm
function scoreFrames(frs: Frame[], idsList: Int16Array[], seq: number[], orientsOf: (f: Frame) => number[], o: AnchorOptions): Scored {
  const m = seq.length;
  const P = 2 * m + 1;
  const F = frs.length;
  if (!F) return { cost: 0, starts: seq.map(() => NaN), ends: seq.map(() => NaN) };
  const cost = (i: number, p: number) => {
    const ors = orientsOf(frs[i]);
    return p % 2 === 0 ? stillCost(frs[i], idsList[p / 2], ors, o.frameCap) : turnCost(frs[i], idsList[(p - 1) / 2], idsList[(p + 1) / 2], ors, o.layerRead, o.frameCap) + o.turnFrameCost;
  };
  const dp = new Float64Array(F * P).fill(Infinity);
  const from = new Int16Array(F * P);
  for (let p = 0; p < P; p++) dp[p] = cost(0, p);
  for (let i = 1; i < F; i++) {
    let run = Infinity;
    let arg = 0;
    for (let p = 0; p < P; p++) {
      const prev = dp[(i - 1) * P + p];
      if (prev < run) {
        run = prev;
        arg = p;
      }
      // 区間 p の前の区間が全部飛ばせる（最後のフレームが Sm に入るまでの安い道を先に見る）
      if (run >= 1e9) continue;
      dp[i * P + p] = run + cost(i, p);
      from[i * P + p] = arg;
    }
  }
  // 最後のフレームは Sm（アンカーのフレーム）
  const end = P - 1;
  const phase = new Int16Array(F);
  phase[F - 1] = end;
  for (let i = F - 1; i > 0; i--) phase[i - 1] = from[i * P + phase[i]];
  const at = (p: number) => {
    let i = 0;
    while (i < F && phase[i] < p) i++;
    if (i === 0) return frs[0].t;
    if (i === F) return frs[F - 1].t;
    return (frs[i - 1].t + frs[i].t) / 2;
  };
  return { cost: dp[(F - 1) * P + end], starts: seq.map((_, k) => at(2 * k + 1)), ends: seq.map((_, k) => at(2 * k + 2)) };
}

// ---- 本体 ----
//
// 根拠なく候補を捨てない: アンカーごとに、それまでのフレームの読みと食い違わない（食い違いが tolerance 以下の）状態をすべて残す
// （上位いくつ、とは切らない。同じ状態・姿勢はまとめる）。読みと食い違う候補だけを落とす。ステッカーの距離の表で届かないと
// 分かる手順は探さない（根拠のある枝刈り）。仮定は 1 つだけ: アンカーの間の手は、見えたステッカーを合わせる一番短い手順の
// 長さ + 1 手まで（それより長い手順は無数にあり、どれも同じように読みと合う）。
// 決められない所: アンカーの間が maxDepth 手より長い・候補が maxSet より多い・時間切れ → その先は前向きでは決めない。
// 完成から後ろ向きにも同じことをして、両側で同じ状態にたどり着いたアンカーでつなぐ。間が残ったら、両側の状態を一番短い手順で
// つないで推定（inferred）にする。つなぐ道が 1 通りに決まらない所も推定にする。

interface Hyp {
  done: number; // 採点し終えたフレーム
  p: Uint8Array; // ステッカーの位置
  orient: number; // -1 = まだ分からない
  mis: number; // ここまでの読みの食い違い（tolerance と比べる区間ごとの量ではなく、合計: 調べ用）
  cost: number; // 手の数（中層回しの 2 手目は oppositeCost）+ 持ち替え（同じ状態に着く道のうちどれを出すかにだけ使う）
  moves: DecodedMove[];
  alt: boolean; // 同じ状態に着く、手順の違う道がほかにもあった
  unsure: number[]; // 道によって違う手の番号（出すときに推定にする）
}

const seqCost = (seq: number[], o: AnchorOptions) => {
  let c = 0;
  for (let i = 0; i < seq.length; i++) {
    const opp = i > 0 && moveFace(seq[i]) !== moveFace(seq[i - 1]) && moveFace(seq[i]) % 3 === moveFace(seq[i - 1]) % 3;
    c += opp ? o.oppositeCost : o.moveCost;
  }
  return c;
};

interface Pass {
  // sets[i]: アンカー i の後に残った状態（決められた所まで）
  sets: Hyp[][];
  resolved: number; // 決められた最後のアンカー（-1: 最初から決められない）
  reason: string;
}

// 仮説の集まり hyps から、アンカー a までのフレームを説明する状態をすべて（読みと食い違う候補だけ落とす）
function advance(frames: Frame[], hyps: Hyp[], a: Anchor, o: AnchorOptions, deadlineAll: number): { out: Map<string, Hyp>; blocked: string } {
  const out = new Map<string, Hyp>();
  let blocked = "";
  for (const h of hyps) {
    o.tick?.();
    if (performance.now() > deadlineAll) return { out, blocked: "時間切れ" };
    const frs = frames.slice(h.done + 1, a.last + 1);
    const ids0 = idsOf(h.p);
    // 動いていない（このアンカーまで手がない）: 読みと食い違わなければ候補
    let still = false;
    {
      let mis = 0;
      for (const f of frs) mis += stillCost(f, ids0, f.centers ?? (h.orient >= 0 ? [h.orient] : ALL_ORIENTS), o.frameCap);
      if (mis <= o.tolerance) {
        still = true;
        add(out, { ...h, done: a.last, mis: h.mis + mis, orient: h.orient >= 0 ? h.orient : (a.orients?.[0] ?? -1) });
      }
    }
    if (still) continue;
    const F = new Layers(Uint8Array.from(a.id.map((x) => h.p[x])), false);
    const orients = a.orients ?? (h.orient >= 0 ? [h.orient] : ALL_ORIENTS);
    const Bs = orients.map((o2) => new Layers(Uint8Array.from(a.pos.map((pp) => VIEW[o2 * 54 + pp])), true));
    // 読みと食い違わない一番短い長さを探し、その長さの候補をすべて残す
    let found = false;
    const tStop = performance.now() + o.connectMs;
    for (let L = 1; L <= o.maxDepth && !found; L++) {
      if (performance.now() > tStop) return { out, blocked: "時間切れ" };
      for (let k = 0; k < orients.length; k++) {
        const o2 = orients[k];
        const seqs = sequencesOfLength(F, Bs[k], L, o.candidates);
        if (seqs === null) return { out, blocked: "候補が多すぎる" };
        for (const seq of seqs) {
          const ps: Uint8Array[] = [h.p];
          for (const mv of seq) ps.push(applyPos(ps[ps.length - 1], mv));
          const idsList = ps.map(idsOf);
          const fallback = h.orient >= 0 && h.orient !== o2 ? [h.orient, o2] : [o2];
          const sc = scoreFrames(frs, idsList, seq, (f) => (f.centers ? f.centers : fallback), o);
          if (sc.cost > o.tolerance) continue; // 読みと食い違う
          found = true;
          const mvs: DecodedMove[] = seq.map((mv, j) => ({ move: mv, t0: sc.starts[j], t: sc.ends[j], orient: h.orient >= 0 ? h.orient : o2 }));
          const rot = h.orient >= 0 && o2 !== h.orient ? o.rotationCost : 0;
          add(out, { done: a.last, p: ps[ps.length - 1], orient: o2, mis: h.mis + sc.cost, cost: h.cost + seqCost(seq, o) + rot, moves: [...h.moves, ...mvs], alt: h.alt, unsure: h.unsure });
        }
      }
    }
  }
  return { out, blocked };
}

function runPass(frames: Frame[], anchors: Anchor[], weak: Anchor[], start: CubeState, o: AnchorOptions): Pass {
  let hyps: Hyp[] = [{ done: -1, p: positionsOf(start), orient: -1, mis: 0, cost: 0, moves: [], alt: false, unsure: [] }];
  const sets: Hyp[][] = [];
  const deadlineAll = performance.now() + o.passMs;
  let lastSkipped = false;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    let { out, blocked } = advance(frames, hyps, a, o, deadlineAll);
    // つなげない（間が長い）: 間の弱い読み（見えたステッカーが少ない区間）を足場にして、短い間ずつ進めてからもう一度
    if (!blocked && !out.size) {
      const from = Math.min(...hyps.map((h) => h.done));
      const steps = weak.filter((w) => w.first > from && w.last < a.first);
      if (steps.length) {
        let hs = hyps;
        for (const w of steps) {
          const r = advance(frames, hs, w, o, deadlineAll);
          if (r.blocked) {
            blocked = r.blocked;
            break;
          }
          if (!r.out.size) continue; // 足場の読み違い: 使わない（次の足場・アンカーで確かめる）
          if (r.out.size > o.maxSet) {
            blocked = "候補が多すぎる";
            break;
          }
          hs = [...r.out.values()];
        }
        if (!blocked) ({ out, blocked } = advance(frames, hs, a, o, deadlineAll));
      }
    }
    if (blocked || !out.size) {
      // 決められない: どの候補もこのアンカーを説明できない（読み違い・間が長すぎる）か、候補が多すぎる・時間切れ。
      // 説明できないアンカーが 1 つだけなら読み違いとみて、そのアンカーの読みを使わずに次へ（次のアンカーが確かめる）
      if (!blocked && i + 1 < anchors.length && !lastSkipped) {
        sets.push(hyps);
        lastSkipped = true;
        o.onAnchor?.({ t0: a.t0, t1: a.t1, stickers: a.pos.length, orients: a.orients, connected: false, hyps: hyps.map(info) });
        continue;
      }
      return { sets, resolved: i - 1, reason: blocked || "つなげない" };
    }
    if (out.size > o.maxSet) return { sets, resolved: i - 1, reason: "候補が多すぎる" };
    hyps = [...out.values()].sort((x, y) => x.cost - y.cost);
    sets.push(hyps);
    lastSkipped = false;
    o.onAnchor?.({ t0: a.t0, t1: a.t1, stickers: a.pos.length, orients: a.orients, connected: true, hyps: hyps.map(info) });
  }
  return { sets, resolved: anchors.length - 1, reason: "" };
}

const info = (h: Hyp) => ({ state: stateOf(h.p), orient: h.orient, cost: h.cost, moves: h.moves.map((m) => m.move) });

// 同じ状態・姿勢の候補はまとめる（安い道を出す。手順の違う道があったことは覚えておく）
function add(out: Map<string, Hyp>, h: Hyp): void {
  const k = `${h.orient}:${tupleKey(h.p)}`;
  const prev = out.get(k);
  if (!prev) {
    out.set(k, h);
    return;
  }
  const keep = h.cost < prev.cost ? h : prev;
  const other = keep === h ? prev : h;
  // 道が違えば、共通の頭と尻尾の間の手を「決まらない」に（どちらの道でも同じ状態に着くので、先は変わらない）
  const a = keep.moves;
  const b = other.moves;
  let head = 0;
  while (head < a.length && head < b.length && a[head].move === b[head].move) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail].move === b[b.length - 1 - tail].move) tail++;
  const unsure = new Set([...keep.unsure, ...other.unsure.filter((i) => i < head)]);
  for (let i = head; i < a.length - tail; i++) unsure.add(i);
  out.set(k, { ...keep, alt: keep.alt || other.alt || unsure.size > keep.unsure.length, unsure: [...unsure].sort((x, y) => x - y) });
}

const marked = (h: Hyp): DecodedMove[] => h.moves.map((m, i) => (h.unsure.includes(i) ? { ...m, inferred: true } : m));

const reversedFrames = (frames: Frame[]): Frame[] => frames.map((f) => ({ ...f, t: -f.t })).reverse();
// 後ろ向きの手順（完成から戻る向き）を、前向きの手順に直す
const forwardMoves = (ms: DecodedMove[]): DecodedMove[] => ms.map((m) => ({ ...m, move: inverseMove(m.move), t0: -m.t, t: -(m.t0 ?? m.t) })).reverse();

export function decodeAnchors(sightings: Sighting[], start: CubeState, end: CubeState | null, options: Partial<AnchorOptions> = {}): AnchorResult {
  const o = { ...DEFAULT_ANCHORS, ...options };
  const frames = toFrames(sightings, o.minWeight);
  const all = anchorsOf(frames, o.minWeak);
  const anchors = all.filter((a) => a.pos.length >= o.minIds);
  const weak = all.filter((a) => a.pos.length < o.minIds);
  const fwd = runPass(frames, anchors, weak, start, o);
  const result = (moves: DecodedMove[], reachedEnd: boolean, extra: Partial<AnchorResult> = {}): AnchorResult => ({
    moves,
    reachedEnd,
    cost: 0,
    anchors: anchors.length,
    skipped: 0,
    forwardTo: fwd.resolved >= 0 ? anchors[fwd.resolved].t1 : null,
    reason: fwd.reason,
    ...extra,
  });
  if (!end) {
    const h = fwd.sets[fwd.resolved]?.[0];
    return result(h ? marked(h) : [], true, { uncertain: (fwd.sets[fwd.resolved]?.length ?? 0) > 1 });
  }
  // 後ろ向き: 完成から。アンカーは時間を逆にしたフレームで作り直す
  const rframes = reversedFrames(frames);
  const rall = anchorsOf(rframes, o.minWeak);
  const ranchors = rall.filter((a) => a.pos.length >= o.minIds);
  const bwd = runPass(rframes, ranchors, rall.filter((a) => a.pos.length < o.minIds), end, o);
  // 前向きのアンカー i と後ろ向きのアンカー j が同じ区間（同じフレームで終わる）で、同じ状態・姿勢の候補をつなぐ
  const endFrame = (a: Anchor, rev: boolean) => (rev ? frames.length - 1 - a.first : a.last);
  const fIdx = new Map<number, number>();
  for (let i = 0; i <= fwd.resolved; i++) fIdx.set(anchors[i].last, i);
  type Join = { f: Hyp; b: Hyp; at: number };
  let joins: Join[] = [];
  for (let j = 0; j <= bwd.resolved && !joins.length; j++) {
    // 後ろ向きのアンカー j は、前向きのフレームでは ranchors[j].first.. を逆にした区間。その区間の最後 = frames.length-1-first
    const i = fIdx.get(endFrame(ranchors[j], true));
    if (i === undefined) continue;
    const fm = new Map<string, Hyp>();
    for (const h of fwd.sets[i]) fm.set(tupleKey(h.p), h);
    for (const b of bwd.sets[j]) {
      const f = fm.get(tupleKey(b.p));
      if (f) joins.push({ f, b, at: i });
    }
  }
  const assemble = (jn: Join) => [...marked(jn.f), ...forwardMoves(marked(jn.b))];
  if (joins.length) {
    // 同じアンカーで両側の候補が複数つながる: 状態が違えば 1 つに決められない（どれも推定）
    joins = joins.sort((x, y) => x.f.cost + x.b.cost - (y.f.cost + y.b.cost));
    const seqs = joins.map(assemble);
    const sure = joins.length === 1 && !joins[0].f.alt && !joins[0].b.alt;
    return result(markUncertain(seqs[0], seqs), true, { method: "meet", uncertain: !sure });
  }
  // 両側が出会わない: 前向きの最後の候補と後ろ向きの最後の候補を、間の時間の手を推定してつなぐ（一番短い手順。推定）
  const fs = fwd.sets[fwd.resolved] ?? [{ done: -1, p: positionsOf(start), orient: -1, mis: 0, cost: 0, moves: [], alt: false, unsure: [] }];
  const bs = bwd.sets[bwd.resolved] ?? [{ done: -1, p: positionsOf(end), orient: -1, mis: 0, cost: 0, moves: [], alt: false, unsure: [] }];
  const xs = Array.from({ length: 54 }, (_, x) => x).filter((x) => !isCenter(x));
  let best: { moves: DecodedMove[]; n: number; count: number } | null = null;
  for (const f of fs)
    for (const b of bs) {
      o.tick?.();
      const r = connectTuples(new Layers(Uint8Array.from(xs.map((x) => f.p[x])), false), Uint8Array.from(xs.map((x) => b.p[x])), o.maxDepth, o.candidates, performance.now() + o.connectMs);
      if (!r.seqs.length) continue;
      const shortest = r.seqs.filter((q) => q.length === r.len);
      const t0 = f.moves.length ? f.moves[f.moves.length - 1].t : (frames[0]?.t ?? 0);
      const bm = forwardMoves(b.moves);
      const t1 = bm.length ? (bm[0].t0 ?? bm[0].t) : (frames[frames.length - 1]?.t ?? t0);
      const mid: DecodedMove[] = shortest[0].map((mv, k) => ({ move: mv, t0: t0 + ((t1 - t0) * k) / r.len, t: t0 + ((t1 - t0) * (k + 1)) / r.len, orient: Math.max(0, f.orient), inferred: true }));
      const all = [...marked(f), ...mid, ...forwardMoves(marked(b))];
      if (!best || r.len < best.n) best = { moves: all, n: r.len, count: shortest.length * fs.length * bs.length };
    }
  if (best) return result(best.moves, true, { method: "bridge", uncertain: true });
  return result(marked(fs[0]), false, { method: "forward", uncertain: true });
}

// 候補の手順が複数あるとき、共通の頭と尻尾より間の手を推定にする
function markUncertain(chosen: DecodedMove[], all: DecodedMove[][]): DecodedMove[] {
  if (all.length < 2) return chosen;
  let head = chosen.length;
  let tail = chosen.length;
  for (const s of all) {
    let h = 0;
    while (h < chosen.length && h < s.length && s[h].move === chosen[h].move) h++;
    let t = 0;
    while (t < chosen.length && t < s.length && s[s.length - 1 - t].move === chosen[chosen.length - 1 - t].move) t++;
    head = Math.min(head, h);
    tail = Math.min(tail, t);
  }
  return chosen.map((m, i) => (i >= head && i < chosen.length - tail ? { ...m, inferred: true } : m));
}

// 試験・調べ用
export const _internal = { toFrames, anchorsOf, connectTuples, positionsOf, stateOf, Layers };
