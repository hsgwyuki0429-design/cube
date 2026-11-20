// ステッカーの動きの方程式を、区間ごとに「連立方程式を表の AND で解く」形で解く（表の AND 版。decode.ts の前の版と同じ点数と答えの確かめ）。
//
// 見え方（decode.ts の buildSights）の間を区間にする。仮説（状態 = ピース 20 個の位置 + センターの向き 6 つ）ごとに、次の見え方の
// 「確かな読み」（置き方が推測に頼らない面の、続いた読みの重みが strongBits 以上のもの = 読み違い 2% 以下）1 個が式 1 本:
// 「区間の始めに位置 x にいたピースは、区間の手順で位置 y に行く」（動かなかったピースも x → x）。同じピースの 2 枚目・3 枚目は
// 食い違いの確かめにだけ使う。センターの向きの式「面 f を回した量 ≡ 向きの差（mod 4）」も足す。式を全部満たす k 手の手順の集合 =
// 表 T[k][x][y] の AND（tables.ts）。k は 0 から増やし、解のある最小の k の解を全部仮説にし、k + 1 の解は弱い読みが 1 手ぶん近く
// 支えるものだけ残す（見えない層の手。後の区間で要るとき、順番が入れ替わった手順で説明しないように）。
// AND が空なら、式を 1 本外して（重みの小さい方から）解く: その区間の手は読み違いのある区間（inferred の候補）。
// 弱い読み（引き継いだ ID・欠片・1 枚だけ・推測の置き方）は、確かな式の解の中から選ぶ点数にだけ使う（集合の外の解は作らない）。
// 仮説は「上位何個」では切らない: 一番よい仮説から keepBits より悪いものだけ落とす（2^−keepBits より起こりにくい）。数が capHyps を
// 超えた見え方（読みが少なく解が多すぎる）だけ安い方から残し、その区間の手は inferred の候補にする。
// 前向き・後ろ向きを交互に進め、同じ見え方で同じ状態になった所でつなぐ。最後に答えの確かめ（decode.ts の verifyPath）を必ず通す:
// 確定にするか inferred にするかはそこで決める（手順を漏れなく探す所は tables.ts の表を使う）。DOM もカメラも知らない
import { type CubeState, NUM_MOVES, inverseMove } from "../../cube/model";
import {
  DEFAULT_DECODE,
  type DecodeOptions,
  type DecodeResult,
  type DecodedPieceMove,
  type M,
  Paths,
  SIZE,
  type SGroup,
  type Sight,
  applySeq,
  buildSights,
  groupCost,
  hash30,
  hashOf,
  sameState,
  verifyPath,
  withCenters,
} from "./decode";
import { NUM_PIECES, TOUCH, piecesOf } from "./model";
import { CENTER_SLOT, type PieceTable, bitsOf } from "./table";
import { type BackTable, CLS, type CenterEq, type Eq, IDX, MAX_TABLE_K, andSet, backTable, isEmpty, positionOf, seqTable, sequencesBetweenStates, solveExact } from "./tables";

export interface SolveOptions {
  moveBits: number; // 1 手のコスト（ビット）
  strongBits: number; // 続いた読み全体の重みがこれ以上の読みを「確かな読み」にする（bitsOf(0.02): 読み違い 2% 以下）
  maxK: number; // 1 区間に入れる手の上限（4 までは表、5〜8 は突き合わせ）
  extraBits: number; // 最小の手の数より多い手の解は、最小の手の数の解よりこれ（ビット）までしか悪くないものだけ仮説にする（手は、その分の食い違いを減らすこと）
  // 一番よい仮説よりこれ（ビット）以上悪い仮説は落とす。答えの確かめの基準（verifyBits 8）と、読み違い 1 本ぶん（10〜13 ビット）の
  // 回り道を残すために、その和ほど
  keepBits: number;
  capHyps: number; // 見え方ごとの仮説の数の上限（超えた見え方だけ安い方から。その区間の手は inferred の候補）
  solLimit: number; // 1 区間の解の数の上限（超えたら安い方から: 手が分からないので inferred の候補）
  endBits: number; // 終わりの状態と違うピース 1 個のコスト
  afterMeetMs: number; // つながってからも、これだけは前向き・後ろ向きとも進める（もっと安いつなぎ目があるか）
  budgetMs: number; // つながらないまま超えたらあきらめる（呼ぶ側はこれまでの解き直しに戻す）
  totalMs: number; // 答えの確かめも含めた時間の上限
  verifyLongHyps: number; // 答えの確かめで、長い区間を解き直すときの見え方ごとの仮説の数の上限
  // 5〜8 手の突き合わせを試すのは、一番よい仮説の表の範囲の計画（4 手まで・読み違い 2 本まで）がこれ（ビット）より高い見え方だけ。
  // 4 手 + 確かな読み 1 本の読み違い ≈ 15 + 12 ビット
  longGateBits: number;
  planBits: number; // 区間ごとに、いちばん安い計画からこれ（ビット）以内の計画を全部仮説にする（確かな読み 1 本の読み違いぶん）
  maxPlans: number; // その上限
  // 見失った: 一番よい仮説の食い違い（コスト − 手）が直近 lostMs で lostBits 以上増えたら、その向きをやめる（前の版と同じ）
  lostMs: number;
  lostBits: number;
  maxMeets: number; // 1 つの見え方で 5〜8 手の突き合わせをする（仮説・組）の数の上限（安い方から）
  deadline?: number; // この時刻（performance.now()）を過ぎたら突き合わせをしない
  extraK: number; // 区間の解の候補は、計画の手の数から これだけ多い手まで（弱い読みが選ぶ。確かな読みのない区間は 0〜2 手の全部）
  maxEval: number; // 1 つの仮説で点数を確かめる候補の上限
  siblingBits: number; // 1 つの仮説の子は、いちばんよい子からこれ（ビット）まで（前の版と同じ 8）
  tick?: () => void; // 進み具合の知らせ（見え方を 1 つ進めるごと。呼ぶ側で 1 秒に 1 回に間引く: vision.worker.ts の phasePoster）
  debugVerify?: (line: string) => void;
  onStep?: (info: { back: boolean; step: number; t: number; hyps: number; best: number; eqs: number; k: number }) => void;
  onInterval?: (info: { back: boolean; step: number; state: Uint8Array; eqs: Eq[]; centers: CenterEq[]; k: number; dropped: number; sols: number[][]; extra: number[][] }) => void; // 調査用
}

export const DEFAULT_SOLVE: SolveOptions = {
  moveBits: Math.log2(13.35),
  strongBits: bitsOf(0.02),
  maxK: 8,
  extraBits: 1,
  keepBits: 20,
  capHyps: 256,
  solLimit: 64,
  endBits: 40,
  afterMeetMs: 1500,
  budgetMs: 8000,
  totalMs: 9000,
  verifyLongHyps: 1024,
  longGateBits: 4 * Math.log2(13.35) + 12,
  planBits: 12,
  maxPlans: 8,
  lostMs: 1500,
  lostBits: 200,
  extraK: 2,
  maxMeets: 12,
  maxEval: 48,
  siblingBits: 8,
};

// 区間の結果の集計（調査用: 区間ごとの「決まらなかった理由」）
// 調査用: 時間の内訳
export const SOLVE_PROFILE = { andMs: 0, dropMs: 0, meetMs: 0, scoreMs: 0, meets: 0, hyps: 0, steps: 0, calls: 0 };

export interface SolveStats {
  intervals: number; // 解いた区間（仮説 × 見え方）
  byK: number[]; // 最小の k ごとの数
  dropped: number; // 式を外して解いた
  stuck: number; // 外しても解けなかった
  multi: number; // 最小の k の解が 2 つ以上
  capped: number; // 仮説が多すぎた見え方
  ms: number;
}

interface Hyp {
  s: Uint8Array;
  cost: number;
  path: number;
  mis: number;
}

// 見え方ごとの確かな式（仮説によらない部分）と、センター 1 つの面の、センターの向きごとの式
interface StrongSight {
  to: Int16Array; // ピース → 行き先（-1 = 確かな読みなし）
  w: Float32Array;
  conflicts: number; // 同じピースが違う所に読めた（重い方を使う）
  center: Int8Array; // センターの向き（置き方の決まった面の確かな読み。-1 = なし）
  chain: { face: number; byPhi: { P: number[]; A: number[]; W: number[] }[] }[]; // センター 1 つの面: 仮説の向き φ ごとの式
  // 弱い読みも含めた全部の読みの食い違いの下限（場所 × 値）: その値をどの置き方の候補でも読んでいなければ、その読みの重み。
  // まとまりの点数（groupCost: 置き方の候補の最小）より大きくならないので、解の候補を安い順に並べて、確かめる数を減らすのに使う
  pen: Float32Array;
  penSlots: number[];
}

function strongOf(sg: Sight, strong: number): StrongSight {
  const to = new Int16Array(NUM_PIECES).fill(-1);
  const w = new Float32Array(NUM_PIECES);
  const center = new Int8Array(6).fill(-1);
  const cw = new Float32Array(6);
  let conflicts = 0;
  const chain: StrongSight["chain"] = [];
  for (const g of sg.groups as SGroup[]) {
    if (!g.robust) continue;
    // 置き方の決まった面（候補は格子の向きの誤りだけ: 既定を使う）
    if (g.sure) {
      for (let i = 0; i < g.n; i++) {
        const a = g.A[i];
        if (a === 255 || g.R[i] < strong) continue;
        const p = g.P[i];
        if (p >= CENTER_SLOT) {
          const f = p - CENTER_SLOT;
          if (center[f] >= 0 && center[f] !== a) conflicts++;
          if (center[f] < 0 || g.R[i] > cw[f]) {
            center[f] = a;
            cw[f] = g.R[i];
          }
          continue;
        }
        if (to[p] >= 0 && to[p] !== a) conflicts++;
        if (to[p] < 0 || g.R[i] > w[p]) {
          to[p] = a;
          w[p] = g.R[i];
        }
      }
      continue;
    }
    // センター 1 つの面: センターの向きの読みが確かなら、仮説のセンターの向きで置き方が決まる
    const ic = g.P.findIndex((p) => p >= CENTER_SLOT);
    if (ic < 0 || g.R[ic] < strong) continue;
    const face = g.P[ic] - CENTER_SLOT;
    const byPhi: StrongSight["chain"][number]["byPhi"] = [0, 1, 2, 3].map(() => ({ P: [], A: [], W: [] }));
    for (let c = 0; c < g.prior.length; c++) {
      if (!Number.isFinite(g.prior[c])) continue;
      const phi = g.A[c * g.n + ic];
      if (phi === 255) continue;
      for (let i = 0; i < g.n; i++) {
        const p = g.P[i];
        const a = g.A[c * g.n + i];
        if (p >= CENTER_SLOT || a === 255 || g.R[i] < strong) continue;
        byPhi[phi].P.push(p);
        byPhi[phi].A.push(a);
        byPhi[phi].W.push(g.R[i]);
      }
    }
    // 同じ面のセンター 1 つのまとまり（別のフレーム）は 1 つに: 向き φ ごとの式を足す（面を回した量の選び方は面ごとに 1 つ）
    const same = chain.find((c) => c.face === face);
    if (same)
      for (let phi = 0; phi < 4; phi++) {
        const a = same.byPhi[phi];
        const b = byPhi[phi];
        for (let i = 0; i < b.P.length; i++) {
          const j = a.P.indexOf(b.P[i]);
          if (j < 0) {
            a.P.push(b.P[i]);
            a.A.push(b.A[i]);
            a.W.push(b.W[i]);
          } else if (a.W[j] < b.W[i]) {
            a.A[j] = b.A[i];
            a.W[j] = b.W[i];
          }
        }
      }
    else chain.push({ face, byPhi });
  }
  const pen = new Float32Array(SIZE * 54);
  const used = new Set<number>();
  for (const g of sg.groups as SGroup[])
    for (let i = 0; i < g.n; i++) {
      const p = g.P[i];
      const ok = new Set<number>();
      for (let c = 0; c < g.prior.length; c++) if (Number.isFinite(g.prior[c])) ok.add(g.A[c * g.n + i]);
      const vals = p >= CENTER_SLOT ? 4 : 54;
      for (let v = 0; v < vals; v++) if (!ok.has(v)) pen[p * 54 + v] += g.W[i];
      used.add(p);
    }
  return { to, w, conflicts, center, chain, pen, penSlots: [...used] };
}

export function solvePieces(table: PieceTable, start: CubeState, end: CubeState, options: Partial<SolveOptions & DecodeOptions> = {}): DecodeResult & { stats: SolveStats; reasons: Record<string, number> } {
  const began = performance.now();
  const opt = { ...DEFAULT_DECODE, ...DEFAULT_SOLVE, ...options, deadline: began + (options.budgetMs ?? DEFAULT_SOLVE.budgetMs) } as SolveOptions & DecodeOptions;
  const sights = buildSights(table, opt);
  const n = sights.length;
  const strong = sights.map((sg) => strongOf(sg, opt.strongBits));
  const a = withCenters(piecesOf(start));
  const b = withCenters(piecesOf(end));
  const stats: SolveStats = { intervals: 0, byK: new Array(opt.maxK + 1).fill(0), dropped: 0, stuck: 0, multi: 0, capped: 0, ms: 0 };
  const rev = sights.map((s) => ({ ...s, t0: -s.t1, t1: -s.t0 })).reverse();
  const strongRev = [...strong].reverse();
  const fw = newRun();
  const bw = newRun();
  const fg = runSteps(sights, strong, a, b, opt, false, fw, stats);
  const bg = runSteps(rev, strongRev, b, a, opt, true, bw, stats);
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
    opt.tick?.();
    if (!Number.isNaN(metT) && (fDone || fT - metT >= opt.afterMeetMs) && (bDone || metT - bT >= opt.afterMeetMs)) break;
    if (performance.now() - began > opt.budgetMs) {
      if (Number.isNaN(metT)) return { sights: n, expanded: 0, moves: [], reachedEnd: false, method: "none", cost: Infinity, ms: performance.now() - began, alternatives: 0, timedOut: true, stats: { ...stats, ms: performance.now() - began }, reasons: {} };
      break;
    }
  }
  // 手の列（見え方の番号つき）
  const fMoves = (path: number): M[] => {
    const out: M[] = [];
    for (let p = path; p >= 0; p = fw.paths.parent[p]) out.push({ move: fw.paths.info[p] & 31, sight: fw.paths.info[p] >> 6, guess: (fw.paths.info[p] & 32) !== 0, amb: false, why: fw.why.get(p) });
    return out.reverse();
  };
  const bMoves = (path: number): M[] => {
    const out: M[] = [];
    for (let p = path; p >= 0; p = bw.paths.parent[p]) out.push({ move: inverseMove(bw.paths.info[p] & 31), sight: n - (bw.paths.info[p] >> 6), guess: (bw.paths.info[p] & 32) !== 0, amb: false, why: bw.why.get(p) });
    return out;
  };
  let best: { cost: number; i: number; f: Hyp; b: Hyp } | null = null;
  for (let i = 0; i < n; i++) {
    const F = fw.sets[i];
    const B = bw.sets[n - 1 - i];
    if (!F || !B) continue;
    for (const [key, x] of F) {
      const y = B.get(key);
      if (y && (!best || x.cost + y.cost - x.mis < best.cost)) best = { cost: x.cost + y.cost - x.mis, i, f: x, b: y };
    }
  }
  let chosen: M[] | null = null;
  let method: DecodeResult["method"] = "none";
  let cost = Number.POSITIVE_INFINITY;
  const fCost = fw.final?.cost ?? Number.POSITIVE_INFINITY;
  const bCost = bw.final?.cost ?? Number.POSITIVE_INFINITY;
  if (best && best.cost <= fCost && best.cost <= bCost) {
    chosen = [...fMoves(best.f.path), ...bMoves(best.b.path)];
    method = "meet";
    cost = best.cost;
  } else if (fw.final && fCost <= bCost) {
    chosen = fMoves(fw.final.path);
    method = "forward";
    cost = fCost;
  } else if (bw.final) {
    chosen = bMoves(bw.final.path);
    method = "backward";
    cost = bCost;
  }
  const info = { sights: n, expanded: stats.intervals };
  if (!chosen) return { ...info, moves: [], reachedEnd: false, method: "none", cost: Number.POSITIVE_INFINITY, ms: performance.now() - began, alternatives: 0, stats: { ...stats, ms: performance.now() - began }, reasons: {} };
  // 答えの確かめ（前の版と同じ）。手順を漏れなく探す所は表で、長い区間はこの解き方で区間だけ解き直す
  const decodeMs = performance.now() - began;
  const v0 = performance.now();
  const verifyMs = Math.max(0, Math.min(opt.verifyMs, opt.totalMs - decodeMs));
  const v = verifyPath(sights, a, b, chosen, { ...opt, verifyMs } as DecodeOptions, {
    between: (A, B, maxLen) => sequencesBetweenStates(A, B, maxLen),
    segment: (sub, A, B, o) => segmentSolutions(sub, A, B, { ...opt, deadline: o.deadline } as SolveOptions & DecodeOptions & { deadline?: number }),
    // 区間だけ解き直して確かめた長い区間で確定にしてよい手: 式を外していない・k + 1 の手（見えない層）でない・仮説が多すぎた区間でない。
    // 前向きと後ろ向きがつながったときは、確かな式の解が複数あった区間の手も（解き直しで別の手順と比べている）。つながらずに片方だけで
    // 終わりまで行った答えは、見失った後の手に当たるので、確かな式で 1 つに決まった手だけ（IMG_5046 の 2.5Mbps で 7 手を確定のまま間違えた）
    trusted: (m) => !m.guess && (!m.why || (method === "meet" && m.why === "multi")),
    blockPin: true,
  });
  opt.tick?.();
  chosen = v.moves;
  const verified = { ...v.stats, ms: Math.round(performance.now() - v0), decodeMs: Math.round(decodeMs) };
  // inferred の理由: 読み違いのある区間（式を外した）・回った層が見えない（その手で動くピースに、次の見え方の確かな読みがない）・
  // 読めたピースが足りない（解が 1 つに決まらない・確かめの錨がない）
  const reasons: Record<string, number> = {};
  const timed = (m: M): DecodedPieceMove => {
    const i = m.sight;
    const before = i > 0 ? sights[Math.min(i, n) - 1].t1 : (sights[0]?.t0 ?? 0);
    const after = i < n ? sights[i].t0 : (sights[n - 1]?.t1 ?? 0);
    // 式を外した区間の手（guess）は inferred の候補: 確定にするかは答えの確かめで決める（漏れなく探した区間で 1 つに決まれば確定）
    const inferred = i >= n || i === 0 || m.amb;
    if (inferred) {
      let why = m.why ?? "";
      if (m.guess || why === "drop" || m.why === "drop") why = "misread";
      else if (i >= n || i === 0) why = "edge";
      else {
        const st = strong[Math.min(i, n - 1)];
        let seen = false;
        for (let p = 0; p < NUM_PIECES && !seen; p++) if (st.to[p] >= 0 && TOUCH[st.to[p]] & (1 << m.move)) seen = true;
        why = seen ? "few" : "hidden";
      }
      reasons[why] = (reasons[why] ?? 0) + 1;
    }
    return { move: m.move, sight: i, t0: Math.min(before, after), t: after, ...(inferred ? { inferred: true } : {}) };
  };
  stats.ms = performance.now() - began;
  return { ...info, moves: chosen.map(timed), reachedEnd: true, method, cost, ms: performance.now() - began, alternatives: 0, verified, stats, reasons, ...(method === "meet" && best ? { meetAt: sights[best.i].t0 } : {}) };
}

interface Run {
  sets: (Map<number, Hyp> | null)[];
  final: Hyp | null;
  paths: Paths;
  why: Map<number, string>; // 手の木の節点 → その手を入れた区間の様子（drop = 式を外した・multi = 解が複数・cap = 仮説が多すぎた）
}
const newRun = (): Run => ({ sets: [], final: null, paths: new Paths(), why: new Map() });

// 状態 s の仮説が見え方 st へ行く区間の式。センター 1 つの面の置き方は、区間の手で回った後のセンターの向きで決まる: その面を回した量 δ
// （0〜3）ごとに「その面の式 + センターの式（面 f を δ 回した）」の組を作る（組のどれか 1 つが成り立つ）。そういう面が 2 つ以上なら、
// 確かな読みの多い 2 面まで（組は 16 まで）
interface Variant {
  eqs: Eq[];
  centers: CenterEq[];
}
function equationsFor(s: Uint8Array, st: StrongSight): Variant[] {
  const base: Eq[] = [];
  const baseTo = new Int16Array(NUM_PIECES).fill(-1);
  for (let p = 0; p < NUM_PIECES; p++)
    if (st.to[p] >= 0) {
      base.push({ from: s[p], to: st.to[p], w: st.w[p] });
      baseTo[p] = st.to[p];
    }
  const centers: CenterEq[] = [];
  for (let f = 0; f < 6; f++) if (st.center[f] >= 0 && s[CENTER_SLOT + f] !== 4) centers.push({ f, d: (st.center[f] - s[CENTER_SLOT + f] + 4) & 3, w: 10 });
  const chains = st.chain
    .filter((ch) => s[CENTER_SLOT + ch.face] !== 4 && st.center[ch.face] < 0)
    .sort((x, y) => Math.max(...y.byPhi.map((b) => b.P.length)) - Math.max(...x.byPhi.map((b) => b.P.length)))
    .slice(0, 2);
  let out: Variant[] = [{ eqs: base, centers }];
  for (const ch of chains) {
    const phi0 = s[CENTER_SLOT + ch.face];
    const next: Variant[] = [];
    for (const v of out)
      for (let d = 0; d < 4; d++) {
        const e = ch.byPhi[(phi0 + d) & 3];
        const eqs = [...v.eqs];
        for (let i = 0; i < e.P.length; i++) {
          const p = e.P[i];
          if (baseTo[p] >= 0) continue; // 置き方の決まった面の読みを優先
          const j = eqs.findIndex((q) => q.from === s[p]);
          if (j >= 0) {
            if (eqs[j].w < e.W[i]) eqs[j] = { from: s[p], to: e.A[i], w: e.W[i] };
            continue;
          }
          eqs.push({ from: s[p], to: e.A[i], w: e.W[i] });
        }
        next.push({ eqs, centers: [...v.centers, { f: ch.face, d, w: 10 }] });
      }
    out = next;
  }
  return out;
}

// 区間の解き方の計画: k 手・外す式（eqs と centers を続けた番号）・コスト（手 + 外した式の重み）。5〜8 手は解そのものも持つ
type Plan = { k: number; cost: number; skip: number[]; long?: number[][] };

// 表で解ける範囲（4 手まで・式を 2 本まで外す）の計画を、いちばん安いものから planBits 以内で全部（外し方・手の数ごとに 1 つ）。
// 確かな読みが 1 本読み違っているとき、本当の手順は「外さずに合わせた別の手順」より読み違い 1 本ぶんほど高いことがある
// （IMG_5046 の 21.0 秒: 本当は R D' R' で読み違い 1 本、外さない 4 手 U R U' D' の方が 9 ビット安かった）。exact: 外さない（終わりの状態）
function cheapPlans(v: Variant, opt: SolveOptions, B: Uint32Array, exact = false): Plan[] {
  const { eqs, centers } = v;
  const mb = opt.moveBits;
  const all = eqs.length + centers.length;
  const wOf = (i: number) => (i < eqs.length ? eqs[i].w : centers[i - eqs.length].w);
  const out: Plan[] = [];
  let best = Number.POSITIVE_INFINITY;
  const limit = () => best + opt.planBits;
  const push = (p: Plan) => {
    out.push(p);
    if (p.cost < best) best = p.cost;
  };
  for (let k = 0; k <= MAX_TABLE_K; k++)
    if (!isEmpty(andSet(k, eqs, centers, -1, B), seqTable(k).words)) {
      push({ k, cost: k * mb, skip: [] });
      break;
    }
  if (exact) return out;
  // 1 本外す（軽い式から）。同じ式を外すなら、いちばん少ない手の数だけ
  const order = Array.from({ length: all }, (_, i) => i).sort((x, y) => wOf(x) - wOf(y));
  const doneSkip = new Set<number>();
  for (let k = 0; k <= MAX_TABLE_K; k++) {
    const W = seqTable(k).words;
    for (const i of order) {
      const c = k * mb + wOf(i);
      if (c > limit()) break;
      if (doneSkip.has(i)) continue;
      if (!isEmpty(andSet(k, eqs, centers, i, B), W)) {
        push({ k, cost: c, skip: [i] });
        doneSkip.add(i);
      }
    }
  }
  // 2 本外す（3 手まで）
  const donePair = new Set<number>();
  for (let k = 0; k <= 3; k++) {
    const W = seqTable(k).words;
    for (let a = 0; a < order.length; a++) {
      if (k * mb + wOf(order[a]) * 2 > limit()) break;
      for (let b = a + 1; b < order.length; b++) {
        const c = k * mb + wOf(order[a]) + wOf(order[b]);
        if (c > limit()) break;
        const pk = order[a] * 64 + order[b];
        if (donePair.has(pk) || doneSkip.has(order[a]) || doneSkip.has(order[b])) continue;
        if (!isEmpty(andSet(k, eqs, centers, order[a], B, order[b]), W)) {
          push({ k, cost: c, skip: [order[a], order[b]] });
          donePair.add(pk);
        }
      }
    }
  }
  return out.filter((p) => p.cost <= limit()).sort((x, y) => x.cost - y.cost).slice(0, opt.maxPlans);
}

// 外さない 5〜8 手で、maxCost より安い計画（突き合わせの後ろ側は見え方の中で使い回す）
function longPlan(v: Variant, opt: SolveOptions, maxCost: number, cache: Map<string, BackTable>): Plan | null {
  for (let k = MAX_TABLE_K + 1; k <= opt.maxK && k * opt.moveBits < maxCost; k++) {
    const b = k - Math.ceil(k / 2);
    const key = `${b}|${v.eqs.map((e) => e.to).join(",")}`;
    let bt = cache.get(key);
    if (!bt) cache.set(key, (bt = backTable(b, v.eqs)));
    SOLVE_PROFILE.meets++;
    const sols = solveExact(k, v.eqs, v.centers, opt.solLimit + 1, bt);
    if (sols.length) return { k, cost: k * opt.moveBits, skip: [], long: sols };
  }
  return null;
}

// 計画の解（と、同じ外し方で k + 1 手の解）
function realize(v: Variant, plan: Plan, opt: SolveOptions): { sols: number[][]; extra: number[][] } {
  if (plan.long) return { sols: plan.long, extra: [] };
  const eqs = v.eqs.filter((_, e) => !plan.skip.includes(e));
  const centers = v.centers.filter((_, e) => !plan.skip.includes(v.eqs.length + e));
  const sols = solveExact(plan.k, eqs, centers, opt.solLimit + 1);
  const extra = plan.k + 1 <= MAX_TABLE_K && eqs.length ? solveExact(plan.k + 1, eqs, centers, opt.solLimit + 1) : [];
  return { sols, extra };
}

// 1 つの見え方の区間を、仮説ごとに解く。まず全部の仮説を表の範囲で解き、5〜8 手の突き合わせは、見え方の一番よい仮説から keepBits 以内に
// なりうる仮説だけ（突き合わせが解き直しの時間のほとんどだった）。返すのは仮説ごとの、いちばん安い計画の組（同じコストの組は全部）
function solveStep(hyps: Hyp[], variantsOf: (h: Hyp) => Variant[], opt: SolveOptions, exact: boolean, stats: SolveStats): { h: Hyp; picks: { v: Variant; plan: Plan }[] }[] {
  SOLVE_PROFILE.calls++;
  const B = new Uint32Array(1352);
  const t0 = performance.now();
  // 読んだピースの位置が同じ仮説（違うのは読めていないピースだけ）は同じ式: 計画を使い回す
  const keyOf = (v: Variant) => `${v.eqs.map((e) => `${e.from}>${e.to}`).join(",")}|${v.centers.map((c) => `${c.f}:${c.d}`).join(",")}`;
  const cheapCache = new Map<string, Plan[]>();
  const longCache = new Map<string, { maxCost: number; plan: Plan | null }>();
  const cheapOf = (v: Variant) => {
    const k = keyOf(v);
    if (!cheapCache.has(k)) cheapCache.set(k, cheapPlans(v, opt, B, exact));
    return cheapCache.get(k)!;
  };
  const jobs = hyps.map((h) => ({ h, items: variantsOf(h).map((v) => ({ v, plans: cheapOf(v) })) }));
  const t1 = performance.now();
  SOLVE_PROFILE.andMs += t1 - t0;
  const minOf = (ps: Plan[]) => (ps.length ? ps[0].cost : Number.POSITIVE_INFINITY);
  let bestEst = Number.POSITIVE_INFINITY;
  for (const j of jobs) for (const it of j.items) bestEst = Math.min(bestEst, j.h.cost + minOf(it.plans));
  const cache = new Map<string, BackTable>();
  const order = [...jobs].sort((x, y) => x.h.cost - y.h.cost);
  // 5〜8 手を探すのは、一番よい仮説でも 4 手 + 読み違い 1 本では説明がつかない区間（速い手順で間の状態が読めなかった）だけ
  const base = order.length ? order[0].h.cost : 0;
  const gated = !exact && bestEst - base <= opt.longGateBits;
  // 突き合わせは、仮説の安い方から maxMeets 組まで（時間の上限 deadline を過ぎたらやめる）
  const pairs: { j: (typeof jobs)[number]; it: (typeof jobs)[number]["items"][number] }[] = [];
  if (!gated) for (const j of order) for (const it of j.items) pairs.push({ j, it });
  pairs.sort((x, y) => x.j.h.cost + minOf(x.it.plans) - (y.j.h.cost + minOf(y.it.plans)));
  let meets = 0;
  if (!gated)
    for (const { j, it } of pairs) {
      if (meets >= opt.maxMeets || (opt.deadline !== undefined && performance.now() > opt.deadline)) break;
      {
        const have = minOf(it.plans);
        const maxCost = Math.min(have + opt.planBits, bestEst + opt.keepBits - j.h.cost);
        if ((MAX_TABLE_K + 1) * opt.moveBits >= maxCost) continue;
        const key = keyOf(it.v);
        const c0 = longCache.get(key);
        let lp: Plan | null;
        if (c0 && (c0.plan ? c0.plan.cost < maxCost : c0.maxCost >= maxCost)) lp = c0.plan && c0.plan.cost < maxCost ? c0.plan : null;
        else {
          meets++;
          lp = longPlan(it.v, opt, maxCost, cache);
          longCache.set(key, { maxCost, plan: lp });
        }
        if (lp) {
          it.plans = [...it.plans, lp].sort((x, y) => x.cost - y.cost);
          bestEst = Math.min(bestEst, j.h.cost + lp.cost);
        }
      }
    }
  SOLVE_PROFILE.meetMs += performance.now() - t1;
  return jobs.map((j) => {
    const c = Math.min(...j.items.map((it) => minOf(it.plans)));
    const picks: { v: Variant; plan: Plan }[] = [];
    for (const it of j.items) for (const plan of it.plans) if (plan.cost <= c + opt.planBits) picks.push({ v: it.v, plan });
    picks.sort((x, y) => x.plan.cost - y.plan.cost);
    stats.intervals++;
    if (picks.length) {
      stats.byK[picks[0].plan.k]++;
      if (picks[0].plan.skip.length) stats.dropped++;
    } else stats.stuck++;
    return { h: j.h, picks: picks.slice(0, opt.maxPlans) };
  });
}

// 仮説 h の区間の解の候補（計画ごとに、最小の手の数 k から k + extraK 手まで）と、食い違いの下限。表の手順の番号のまま並べる
interface Cand {
  moves: number[];
  lb: number; // 手 + 読みの食い違いの下限（ビット）
  extra: number; // 計画の手の数より多い手の数
  plan: Plan;
}
function candidatesOf(s: Uint8Array, v: Variant, plan: Plan, st: StrongSight | null, opt: SolveOptions, B: Uint32Array): Cand[] {
  const out: Cand[] = [];
  const lbOf = (img: (p: number) => number, k: number) => {
    let c = k * opt.moveBits;
    if (st) for (const p of st.penSlots) c += st.pen[p * 54 + img(p)];
    return c;
  };
  if (plan.long) {
    for (const q of plan.long.slice(0, opt.solLimit)) {
      const t = applySeq(s, q);
      out.push({ moves: q, lb: lbOf((p) => t[p], q.length), extra: 0, plan });
    }
    return out;
  }
  const eqs = v.eqs.filter((_, e) => !plan.skip.includes(e));
  const centers = v.centers.filter((_, e) => !plan.skip.includes(v.eqs.length + e));
  const kMax = st ? Math.min(MAX_TABLE_K, plan.k + opt.extraK) : plan.k;
  for (let k = plan.k; k <= kMax; k++) {
    const tb = seqTable(k);
    const bits = andSet(k, eqs, centers, -1, B);
    for (let w = 0; w < tb.words; w++) {
      let x = bits[w];
      while (x) {
        const bit = 31 - Math.clz32(x & -x);
        x &= x - 1;
        const i = w * 32 + bit;
        const img = (p: number) => {
          const val = s[p];
          if (p >= CENTER_SLOT) return val === 4 ? 4 : (val + tb.amount[i * 6 + p - CENTER_SLOT]) & 3;
          return positionOf(CLS[val], tb.img[(i * 2 + CLS[val]) * 24 + IDX[val]]);
        };
        out.push({ moves: Array.from(tb.moves.subarray(i * k, (i + 1) * k)), lb: lbOf(img, k), extra: k - plan.k, plan });
      }
    }
  }
  return out;
}

// 前向き（back なら後ろ向き）に見え方を 1 つずつ。結果は run に書く
function* runSteps(sights: Sight[], strong: StrongSight[], start: Uint8Array, end: Uint8Array | null, opt: SolveOptions & DecodeOptions, back: boolean, run: Run, stats: SolveStats): Generator<number, void, void> {
  const paths = run.paths;
  let cur: Hyp[] = [{ s: start.slice(), cost: 0, path: -1, mis: 0 }];
  const health: { t: number; v: number }[] = [];
  const steps = end ? sights.length + 1 : sights.length;
  const endGroups: SGroup[] = end ? [{ robust: true, n: NUM_PIECES, np: NUM_PIECES, nc: 1, P: Uint8Array.from({ length: NUM_PIECES }, (_, k) => k), A: end.slice(0, NUM_PIECES), prior: new Float32Array(1), W: new Float32Array(NUM_PIECES).fill(opt.endBits), R: new Float32Array(NUM_PIECES).fill(opt.endBits) }] : [];
  for (let step = 0; step < steps; step++) {
    const last = step === sights.length;
    const G = last ? endGroups : (sights[step].groups as SGroup[]);
    // センターの向きは、置き方の決まった面の確かな読み（続いた読み: 読み違い 2% 以下）で覚える。1 枚だけの読み（13%）で覚えると、向きが
    // ずれたまま 1 面だけ見える区間の置き方を選び、正しい手（D2）を外して別の手（D'）にした（IMG_5046 の 2.5Mbps、27.6 秒）
    const learn = last ? null : strong[step].center;
    const pool = new Map<number, Hyp[]>();
    let best = Number.POSITIVE_INFINITY;
    const add = (h: Hyp, seq: number[], why: string | undefined, guess: boolean, limit: number, extraCost = 0): Hyp | null => {
      const t0 = performance.now();
      const s = applySeq(h.s, seq);
      if (learn) for (let f = 0; f < 6; f++) if (learn[f] >= 0 && s[CENTER_SLOT + f] === 4) s[CENTER_SLOT + f] = learn[f];
      let mis = 0;
      for (const g of G) mis += groupCost(g, s, Number.POSITIVE_INFINITY);
      SOLVE_PROFILE.scoreMs += performance.now() - t0;
      const c = h.cost + seq.length * opt.moveBits + mis + extraCost;
      if (c > limit) return null;
      const key = hash30(s);
      let l = pool.get(key);
      if (!l) pool.set(key, (l = []));
      const old = l.find((x) => sameState(x.s, s));
      if (old && old.cost <= c) return old;
      let path = h.path;
      for (const m of seq) {
        path = paths.add(path, m, step, guess);
        if (why) run.why.set(path, why);
      }
      const hyp: Hyp = { s, cost: c, path, mis };
      if (old) l[l.indexOf(old)] = hyp;
      else l.push(hyp);
      if (c < best) best = c;
      return hyp;
    };
    const variantsOf = (h: Hyp): Variant[] => {
      if (!last) return equationsFor(h.s, strong[step]);
      const eqs: Eq[] = [];
      for (let p = 0; p < NUM_PIECES; p++) eqs.push({ from: h.s[p], to: end![p], w: opt.endBits });
      return [{ eqs, centers: [] }];
    };
    let eqCount = 0;
    let kSeen = 0;
    const B = new Uint32Array(1352);
    for (const { h, picks } of solveStep(cur, variantsOf, opt, last, stats)) {
      if (!picks.length) {
        // 外しても解けない（読み違いが多い・仮説が違う）: 手を入れずに残す（この区間は読み違いのある区間）
        if (!last) add(h, [], "drop", true, Number.POSITIVE_INFINITY);
        continue;
      }
      // 候補を下限の安い順に確かめ、下限が「この仮説のいちばんよい子 + siblingBits」を超えたらやめる（枝刈り。結果は全部確かめたのと同じ）
      const cands: Cand[] = [];
      for (const { v, plan } of picks) {
        eqCount = Math.max(eqCount, v.eqs.length);
        kSeen = Math.max(kSeen, plan.k);
        const cs = candidatesOf(h.s, v, plan, last ? null : strong[step], opt, B);
        cands.push(...cs);
        opt.onInterval?.({ back, step, state: h.s, eqs: v.eqs, centers: v.centers, k: plan.k, dropped: plan.skip.length, sols: cs.filter((c) => !c.extra).map((c) => c.moves), extra: cs.filter((c) => c.extra).map((c) => c.moves) });
      }
      cands.sort((x, y) => x.lb - y.lb);
      const multi = cands.filter((c) => c.extra === 0).length > 1;
      const seen = new Set<string>();
      const done: { c: Cand; cost: number }[] = [];
      let bestHere = Number.POSITIVE_INFINITY;
      for (const c of cands) {
        if (h.cost + c.lb > bestHere + opt.siblingBits || done.length >= opt.maxEval) break;
        const key = c.moves.join();
        if (seen.has(key)) continue;
        seen.add(key);
        const t = applySeq(h.s, c.moves);
        let mis = 0;
        for (const g of G) mis += groupCost(g, t, Number.POSITIVE_INFINITY);
        const cost = h.cost + c.moves.length * opt.moveBits + mis;
        done.push({ c, cost });
        if (cost < bestHere) bestHere = cost;
      }
      // 最小の手の数の解のいちばんよいもの。それより手の多い解は、弱い読みが手の分をほぼ取り返すものだけ（見えない層の手）
      let base = Number.POSITIVE_INFINITY;
      for (const d of done) if (d.c.extra === 0 && d.cost < base) base = d.cost;
      for (const d of done) {
        if (d.cost > bestHere + opt.siblingBits) continue;
        if (d.c.extra > 0 && d.cost > base + opt.extraBits) continue;
        const why = d.c.plan.skip.length ? "drop" : d.c.extra ? "extra" : multi ? "multi" : undefined;
        add(h, d.c.moves, why, d.c.plan.skip.length > 0, Number.POSITIVE_INFINITY);
      }
      if (multi) stats.multi++;
    }
    let all: Hyp[] = [];
    for (const l of pool.values()) for (const h of l) if (h.cost <= best + opt.keepBits) all.push(h);
    SOLVE_PROFILE.hyps += cur.length;
    SOLVE_PROFILE.steps++;
    if (all.length > opt.capHyps) {
      all.sort((x, y) => x.cost - y.cost);
      all.length = opt.capHyps;
      stats.capped++;
      for (const h of all) if (h.path >= 0 && (paths.info[h.path] >> 6) === step && !run.why.has(h.path)) run.why.set(h.path, "cap");
    }
    cur = all;
    if (!cur.length) break;
    opt.onStep?.({ back, step, t: last ? Number.NaN : Math.abs(sights[step].t0), hyps: cur.length, best, eqs: eqCount, k: kSeen });
    if (last) {
      run.final = cur.find((h) => h.s.every((y, k) => k >= NUM_PIECES || y === end![k])) ?? null;
      break;
    }
    const set = new Map<number, Hyp>();
    for (const h of cur) {
      const k = hashOf(h.s, NUM_PIECES);
      const o = set.get(k);
      if (!o || o.cost > h.cost) set.set(k, h);
    }
    run.sets.push(set);
    let bestH = cur[0];
    for (const h of cur) if (h.cost < bestH.cost) bestH = h;
    const v = bestH.cost - paths.depthOf(bestH.path) * opt.moveBits;
    const t = Math.abs(sights[step].t1);
    health.push({ t, v });
    let j = health.length - 1;
    while (j > 0 && t - health[j - 1].t <= opt.lostMs) j--;
    if (v - health[j].v >= opt.lostBits) break;
    yield step;
  }
}

// 答えの確かめの長い区間（8〜16 手）: 区間だけを同じ解き方で解き直し、終わりの状態 B に着く手順を集める。同じ状態に違う手順で着いた
// ものも残す（どちらの手順かが決まらないことを確かめるため）
function segmentSolutions(sub: Sight[], A: Uint8Array, B: Uint8Array, opt: SolveOptions & DecodeOptions & { deadline?: number }): number[][] | null {
  const strong = sub.map((sg) => strongOf(sg, opt.strongBits));
  const stats: SolveStats = { intervals: 0, byK: new Array(opt.maxK + 1).fill(0), dropped: 0, stuck: 0, multi: 0, capped: 0, ms: 0 };
  // 状態 → 手順たち（コストの安い方から 8 個まで）
  type P = Hyp & { seq: number[] };
  let cur: P[] = [{ s: A.slice(), cost: 0, path: -1, mis: 0, seq: [] }];
  for (let i = 0; i <= sub.length; i++) {
    if (opt.deadline !== undefined && performance.now() > opt.deadline) return null;
    const last = i === sub.length;
    const next = new Map<number, P[]>();
    let best = Number.POSITIVE_INFINITY;
    const variantsOf = (h: Hyp): Variant[] => {
      if (!last) return equationsFor(h.s, strong[i]);
      const eqs: Eq[] = [];
      for (let p = 0; p < NUM_PIECES; p++) eqs.push({ from: h.s[p], to: B[p], w: opt.endBits });
      return [{ eqs, centers: [] }];
    };
    for (const { h, picks } of solveStep(cur, variantsOf, opt, last, stats)) {
      for (const { v, plan } of picks) {
        const { sols, extra } = realize(v, plan, opt);
        for (const seq of [...sols.slice(0, opt.solLimit), ...extra.slice(0, opt.solLimit)]) {
          const s = applySeq(h.s, seq);
          let mis = 0;
          if (!last) for (const g of sub[i].groups as SGroup[]) mis += groupCost(g, s, Number.POSITIVE_INFINITY);
          const c = h.cost + seq.length * opt.moveBits + mis;
          const key = hash30(s);
          let l = next.get(key);
          if (!l) next.set(key, (l = []));
          l.push({ s, cost: c, path: -1, mis, seq: [...(h as P).seq, ...seq] });
          if (c < best) best = c;
        }
      }
    }
    const all: P[] = [];
    for (const l of next.values()) {
      l.sort((x, y) => x.cost - y.cost);
      for (const p of l.slice(0, 8)) if (p.cost <= best + opt.keepBits) all.push(p);
    }
    if (all.length > opt.verifyLongHyps) return null;
    cur = all;
    if (!cur.length) return null;
  }
  const done = cur.filter((p) => p.s.every((v, k) => k >= NUM_PIECES || v === B[k])).sort((x, y) => x.cost - y.cost);
  return done.map((p) => p.seq);
}

export { SIZE, NUM_MOVES };
