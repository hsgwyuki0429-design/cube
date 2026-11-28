// ソルブの記録から練習に役立つ数字を出す（手数・CFOP のフェーズごとの時間と TPS・止まった所・TPS の推移・持ち替え・クロス・X クロス・
// 無駄な回転）。純粋な関数だけ（DOM もカメラも知らない）。画面にはまだ出していない。
//
// 入力は手の並び（キューブ固定の手・回し始め・回し終わり・その時のキューブの向き・推定か・時刻をフレームから決めたか）と始まりの状態。
// 記録（Solve）からは statsInputFromSolve、精密解析の結果（RefineResult.moves はこの形のまま渡せる）からはそのまま。
//
// 扱いの決まり:
// - 止めた後の手は数えない: `stopAt`（ms）より後に回し終わる手は外す（記録の手は精密解析が打ち切った後なので、ふつうは要らない。
//   打ち切った数 Solve.edges.stop.cut は `cutBefore` として結果に添えるだけ）
// - 推定の手（inferred: どの手か決まらなかった）は、状態をつなぐのに要るので手数・フェーズの区切りには入れる。結果にその数を添え、
//   推定の手を含むフェーズ・止まった所・持ち替え・無駄な回転は uncertain にする（推定の手の時刻・向きは前後からの見込み）
// - 時刻をフレームから決められなかった手（exact === false）は、その手の前後の止まった所の長さを uncertain にする。exact が無い
//   （記録 Solve には残っていない）ときは「分からない」とし、推定でない手の時刻はそのまま使う（結果の notes に書く）
// - 精密解析は同じ面の手をまとめた後の手を返す（D' D' → D2。時刻は 1 回目の回し始め〜2 回目の回し終わり）。まとめられた手の間で
//   止まっていても、その止まりは手の中に入って見えない。無駄な回転も残っている分しか拾えない（notes に書く）
import { crossDone, cfopSplits, crossFaceOf } from "./analysis";
import { slotDone, slotsFor } from "./f2l";
import {
  type CubeState,
  type Mat3,
  MOVE_NAMES,
  ORIENTATIONS,
  ROTATION,
  applyMove,
  applyMoves,
  isSolved,
  moveFace,
  moveIndex,
  mul,
  orientationIndex,
  parseMoves,
  solvedState,
  transpose,
} from "./model";

export interface StatsMove {
  move: number; // キューブ固定（センター基準）の手（MOVE_NAMES の番号）
  start: number; // 回し始め（ms）
  end: number; // 回し終わり（ms）
  orient?: number; // その手を回したときのキューブの向き（キューブ固定 → カメラ。ORIENTATIONS の番号）
  inferred?: boolean; // どの手か決まらなかった（推定）
  exact?: boolean; // 時刻をフレームから決めた（false = 観測の時刻のまま。undefined = 分からない）
}

export interface StatsInput {
  startState: CubeState;
  moves: StatsMove[];
  stopAt?: number; // ライブが止めた時刻（ms）。これより後に回し終わる手は数えない
  cutBefore?: number; // 精密解析がもう外した、止めた後の手の数（Solve.edges.stop.cut。数えないで添えるだけ）
}

export interface StatsOptions {
  targetMoves?: number; // 目標の手数（HTM）。既定 50
  pauseMs?: number; // これ以上の手と手の間を「止まった所」にする。既定 300
  tpsWindow?: number; // 手ごとの移動平均の手数。既定 5
  peekMs?: number; // 持ち替えの後これ以内に元の向きに戻した 2 回を「傾けて戻した」（peek）にする。既定 1500
  selfView?: boolean; // 持ち替えの回転を「自分視点」（カメラが自分の方を向いている: カメラフレームを y2 回した）で書く。既定 false（カメラから見て）
}

export const PHASE_NAMES = ["クロス", "F2L 1", "F2L 2", "F2L 3", "F2L 4", "OLL", "PLL"] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

export interface PhaseStat {
  name: PhaseName;
  from: number; // この区間の最初の手の番号（数えた手の中で）
  to: number; // この区間が終わった手の番号 + 1（= 区切りの index。from === to なら手なし: スキップ・前の区間と同じ手で済んだ）
  moves: number; // HTM
  ms: number; // 前の区間が終わった手の回し終わり（クロスは最初の手の回し始め）〜この区間の最後の手の回し終わり。見る時間（止まり）も含む
  execMs: number; // この区間の最初の手の回し始め〜最後の手の回し終わり（回している時間）
  tps: number; // moves / ms（ms が 0 なら 0）
  inferred: number; // この区間の推定の手
  uncertain: boolean; // 推定の手を含む・端の時刻をフレームから決められなかった
}

export interface Pause {
  after: number; // この番号の手の後（次の手は after + 1）
  at: number; // 止まり始め（前の手の回し終わり、ms）
  ms: number;
  phase: PhaseName | null; // 次の手のフェーズ（区切りが分からなければ null）
  boundary: string | null; // フェーズのつなぎ目なら「クロス→F2L 1」など
  uncertain: boolean; // 前後のどちらかが推定の手・時刻をフレームから決められなかった
}

export interface PhaseGap {
  name: string; // 「クロス→F2L 1」「F2L 1→F2L 2」…「F2L 4→OLL」「OLL→PLL」
  ms: number | null; // 前の区間の最後の手の回し終わり → 次の区間の最初の手の回し始め。次の区間が同じ手で済んだ（X クロス・スキップ）なら null
  merged: boolean; // 次の区間に手がない（前の区間と同じ手で済んだ・スキップ）
  uncertain: boolean;
}

export interface Regrip {
  after: number; // この番号の手と次の手の間で向きが変わった
  at: number; // 前の手の回し終わりと次の手の回し始めの真ん中（ms）
  from: number;
  to: number;
  rotation: string; // 「y'」「x2」「x y」など（いちばん短い書き方。カメラから見て、selfView なら自分視点）
  axes: ("x" | "y" | "z")[];
  phase: PhaseName | null; // 次の手のフェーズ
  peek: boolean; // 傾けて戻した（次の持ち替えで peekMs 以内に元の向きに戻った・その戻り）
  uncertain: boolean; // 前後のどちらかが推定の手（推定の手の向きは見込み）
}

export interface Waste {
  from: number; // 同じ面の手が続いた所の最初の手の番号
  to: number; // 最後の手の番号 + 1
  moves: string[]; // 「R」「R'」など
  net: string; // 合わせた手（打ち消し合えば ""）
  saved: number; // まとめれば減る手数（HTM）
  kind: "repeat" | "cross-f2l"; // repeat = 同じ面の手が続いた / cross-f2l = クロスの最後の手と F2L の最初の手が同じ面
  uncertain: boolean;
}

export interface SolveStats {
  counted: number; // 数えた手
  excludedAfterStop: number; // stopAt より後で外した手
  cutBefore: number; // 精密解析がもう外していた手（入力の cutBefore）
  inferred: number; // 推定の手（数には入れた）
  notExact: number; // 時刻をフレームから決められなかった手（推定の手を除く）
  exactKnown: boolean; // 入力に exact があった
  solved: boolean; // 数えた手で揃いに着く
  start: number | null; // 最初の手の回し始め
  end: number | null; // 最後の手の回し終わり
  ms: number; // end − start
  htm: number;
  qtm: number;
  target: number;
  overTarget: number; // htm − target（負なら目標より少ない）
  tps: number; // htm / ms
  phases: PhaseStat[] | null; // 揃わない・クロスの面が決まらないなら null
  crossFace: number; // クロスを作った面（分からなければ −1）
  firstPairMs: number | null; // 初動タイム: 回し始め〜F2L 1 個目が入った手の回し終わり
  pauses: Pause[]; // pauseMs 以上の止まり
  pauseTotalMs: number;
  pauseSureMs: number; // そのうち uncertain でないもの
  gaps: PhaseGap[]; // フェーズのつなぎ目（しきい値によらず全部）
  tpsPerSecond: { t: number; moves: number; uncertain: boolean }[]; // 回し始めから 1 秒ごと（回し終わりがその 1 秒に入る手の数）
  tpsRolling: { at: number; tps: number }[]; // 手ごとの移動平均（その手で終わる tpsWindow 手。at = その手の回し終わり）
  regrips: Regrip[];
  regripsNet: number; // 傾けて戻したものを除いた持ち替え
  regripsInCross: number; // クロスの手の間の持ち替え（傾けて戻したものも数える）
  cross: { moves: number; within8: boolean; regrips: number; noRegrip: boolean } | null;
  xcross: { done: boolean; slots: [number, number][]; withLastCrossMove: boolean } | null; // done = クロスが揃った手で F2L のペアも入っていた / withLastCrossMove = そのペアがクロスの最後の手で入った
  waste: Waste[];
  wasteMoves: number; // まとめれば減る手数の合計
  notes: string[];
}

const QUARTERS = (m: number) => (m % 3 === 1 ? 2 : 1);

// 24 通りの回転それぞれの、いちばん短い x・y・z の書き方（カメラフレームで順に回す）
const ROT_STEPS: { name: string; axis: "x" | "y" | "z"; m: Mat3 }[] = (["x", "y", "z"] as const).flatMap((a) =>
  [1, 2, 3].map((k) => {
    let m: Mat3 = ROTATION[a];
    for (let i = 1; i < k; i++) m = mul(ROTATION[a], m);
    return { name: `${a}${k === 2 ? "2" : k === 3 ? "'" : ""}`, axis: a, m };
  }),
);
const ROT_NAME: { name: string; axes: ("x" | "y" | "z")[] }[] = (() => {
  const out: { name: string; axes: ("x" | "y" | "z")[] }[] = [];
  out[orientationIndex([1, 0, 0, 0, 1, 0, 0, 0, 1])] = { name: "", axes: [] };
  for (const s of ROT_STEPS) out[orientationIndex(s.m)] ??= { name: s.name, axes: [s.axis] };
  for (const a of ROT_STEPS)
    for (const b of ROT_STEPS) {
      if (a.axis === b.axis) continue;
      out[orientationIndex(mul(b.m, a.m))] ??= { name: `${a.name} ${b.name}`, axes: [a.axis, b.axis] };
    }
  return out;
})();
const Y2 = mul(ROTATION.y, ROTATION.y);

// 向き a → b の持ち替え（カメラフレームでキューブを回した回転）
export function regripRotation(a: number, b: number, selfView = false): { name: string; axes: ("x" | "y" | "z")[] } {
  let rel = mul(ORIENTATIONS[b], transpose(ORIENTATIONS[a]));
  if (selfView) rel = mul(mul(Y2, rel), transpose(Y2));
  return ROT_NAME[orientationIndex(rel)];
}

// 記録（src/app/storage.ts の Solve）のうち使う所（src/cube は app を知らないので形だけ）
export interface SolveRecordLike {
  scramble: string;
  moves: { m: string; t: number; s?: number; o?: number; inferred?: boolean }[];
  edges?: { stop?: { cut?: number } };
}

// 記録（Solve）から。始まりの状態はスクランブル（精密解析が始まりの状態を見直したときは記録のスクランブルも書き換えてある）。
// 時刻は計測開始からの ms。記録には exact が残っていない（回し始め s が無い古い記録の手は exact: false）
export function statsInputFromSolve(solve: SolveRecordLike): StatsInput {
  const startState = applyMoves(solvedState(), parseMoves(solve.scramble));
  const moves: StatsMove[] = solve.moves.map((m) => ({
    move: moveIndex(m.m),
    start: m.s ?? m.t,
    end: m.t,
    ...(m.o !== undefined ? { orient: m.o } : {}),
    ...(m.inferred ? { inferred: true } : {}),
    ...(m.s === undefined ? { exact: false } : {}),
  }));
  return { startState, moves, ...(solve.edges?.stop?.cut ? { cutBefore: solve.edges.stop.cut } : {}) };
}

export function solveStats(input: StatsInput, opts: StatsOptions = {}): SolveStats {
  const target = opts.targetMoves ?? 50;
  const pauseMs = opts.pauseMs ?? 300;
  const win = Math.max(2, opts.tpsWindow ?? 5);
  const all = input.moves;
  const moves = input.stopAt === undefined ? all : all.filter((m) => m.end <= input.stopAt!);
  const n = moves.length;
  const ids = moves.map((m) => m.move);
  const exactKnown = moves.some((m) => m.exact !== undefined);
  const notes: string[] = [
    "手は精密解析が同じ面の手をまとめた後のもの（D' D' → D2 など）。まとめられた手の間の止まり・無駄な回転は見えない",
    "中層の手（M など）はセンター基準で両側の面の 2 手として数える",
  ];
  if (!exactKnown) notes.push("時刻をフレームから決めたかは記録に無い（推定でない手の時刻はそのまま使った）");
  const sureTime = (m: StatsMove) => !m.inferred && m.exact !== false;

  const states: CubeState[] = [input.startState];
  for (const m of ids) states.push(applyMove(states[states.length - 1], m));
  const solved = isSolved(states[n]);
  const start = n ? moves[0].start : null;
  const end = n ? moves[n - 1].end : null;
  const ms = start !== null && end !== null ? Math.max(0, end - start) : 0;
  const htm = n;
  const qtm = ids.reduce((s, m) => s + QUARTERS(m), 0);

  // フェーズ: クロス・F2L 1〜4・OLL・PLL の区切り（何手回した後に済んだか）
  const sp = cfopSplits(input.startState, ids);
  const crossFace = sp ? crossFaceOf(input.startState, ids) : -1;
  let bounds: number[] | null = null; // 7 区間それぞれが済んだ手の数
  if (sp && crossFace >= 0) {
    const slots = slotsFor(crossFace);
    const ci = sp[0].index;
    const pairs = [1, 2, 3, 4].map((k) => {
      for (let i = ci; i <= n; i++) if (crossDone(states[i], crossFace) && slots.filter((sl) => slotDone(states[i], crossFace, sl)).length >= k) return i;
      return n;
    });
    pairs[3] = Math.max(pairs[2], Math.min(pairs[3], sp[1].index));
    bounds = [ci, ...pairs, sp[2].index, sp[3].index];
    for (let i = 1; i < bounds.length; i++) bounds[i] = Math.max(bounds[i], bounds[i - 1]);
  } else notes.push(solved ? "クロスの面が決まらないので、フェーズの数字は出さない" : "数えた手で揃いに着かないので、フェーズの数字は出さない");
  // 手 i（0 始まり）のフェーズ
  const phaseOf = (i: number): PhaseName | null => {
    if (!bounds || i < 0 || i >= n) return null;
    const k = bounds.findIndex((b) => i < b);
    return k >= 0 ? PHASE_NAMES[k] : null;
  };
  const endAt = (k: number) => (k > 0 ? moves[k - 1].end : (start ?? 0)); // k 手回した後の時刻

  let phases: PhaseStat[] | null = null;
  if (bounds) {
    phases = PHASE_NAMES.map((name, j) => {
      const from = j ? bounds![j - 1] : 0;
      const to = bounds![j];
      const span = moves.slice(from, to);
      const pms = to > from ? Math.max(0, endAt(to) - endAt(from)) : 0;
      const exec = to > from ? Math.max(0, moves[to - 1].end - moves[from].start) : 0;
      const inf = span.filter((m) => m.inferred).length;
      const edgeUnsure = to > from && (!sureTime(moves[to - 1]) || !sureTime(moves[from]) || (from > 0 && !sureTime(moves[from - 1])));
      return { name, from, to, moves: to - from, ms: pms, execMs: exec, tps: pms > 0 ? (to - from) / (pms / 1000) : 0, inferred: inf, uncertain: inf > 0 || edgeUnsure };
    });
  }
  const firstPairMs = bounds && bounds[1] > 0 && start !== null ? Math.max(0, moves[bounds[1] - 1].end - start) : null;

  // 止まった所・フェーズのつなぎ目
  const gapAfter = (i: number) => moves[i + 1].start - moves[i].end; // 手 i と手 i + 1 の間
  const gapUnsure = (i: number) => !sureTime(moves[i]) || !sureTime(moves[i + 1]);
  const boundaryAt = new Map<number, string>(); // 手 i の後がつなぎ目
  const gaps: PhaseGap[] = [];
  if (bounds)
    for (let j = 0; j + 1 < PHASE_NAMES.length; j++) {
      const name = `${PHASE_NAMES[j]}→${PHASE_NAMES[j + 1]}`;
      const k = bounds[j];
      const merged = bounds[j + 1] === k;
      const ok = !merged && k > 0 && k < n;
      if (ok) boundaryAt.set(k - 1, name);
      gaps.push({ name, ms: ok ? gapAfter(k - 1) : null, merged, uncertain: ok ? gapUnsure(k - 1) : false });
    }
  const pauses: Pause[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const g = gapAfter(i);
    if (g < pauseMs) continue;
    pauses.push({ after: i, at: moves[i].end, ms: g, phase: phaseOf(i + 1), boundary: boundaryAt.get(i) ?? null, uncertain: gapUnsure(i) });
  }
  const pauseTotalMs = pauses.reduce((s, p) => s + p.ms, 0);
  const pauseSureMs = pauses.filter((p) => !p.uncertain).reduce((s, p) => s + p.ms, 0);

  // TPS の推移
  const tpsPerSecond: SolveStats["tpsPerSecond"] = [];
  if (start !== null && end !== null) {
    const bins = Math.max(1, Math.ceil((end - start) / 1000));
    for (let b = 0; b < bins; b++) tpsPerSecond.push({ t: b * 1000, moves: 0, uncertain: false });
    for (const m of moves) {
      const b = Math.min(bins - 1, Math.max(0, Math.floor((m.end - start) / 1000)));
      tpsPerSecond[b].moves++;
      if (!sureTime(m)) tpsPerSecond[b].uncertain = true;
    }
  }
  const tpsRolling: SolveStats["tpsRolling"] = [];
  for (let i = win - 1; i < n; i++) {
    const dt = moves[i].end - moves[i - win + 1].start;
    tpsRolling.push({ at: moves[i].end, tps: dt > 0 ? win / (dt / 1000) : 0 });
  }

  // 持ち替え（手ごとの向きが変わった所）
  const regrips: Regrip[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = moves[i].orient;
    const b = moves[i + 1].orient;
    if (a === undefined || b === undefined || a === b) continue;
    const r = regripRotation(a, b, opts.selfView);
    regrips.push({ after: i, at: (moves[i].end + moves[i + 1].start) / 2, from: a, to: b, rotation: r.name, axes: r.axes, phase: phaseOf(i + 1), peek: false, uncertain: !!(moves[i].inferred || moves[i + 1].inferred) });
  }
  const peekMs = opts.peekMs ?? 1500;
  for (let k = 0; k + 1 < regrips.length; k++) {
    const a = regrips[k];
    const b = regrips[k + 1];
    if (a.peek || b.from !== a.to || b.to !== a.from || b.at - a.at > peekMs) continue;
    a.peek = b.peek = true;
    k++;
  }
  const regripsNet = regrips.filter((r) => !r.peek).length;
  if (!moves.some((m) => m.orient !== undefined)) notes.push("手ごとの向きが無いので、持ち替えは数えない");
  const regripsInCross = bounds ? regrips.filter((r) => r.after + 1 < bounds![0]).length : 0;
  const cross = bounds ? { moves: bounds[0], within8: bounds[0] <= 8, regrips: regripsInCross, noRegrip: regripsInCross === 0 } : null;

  // X クロス: クロスが揃った手で F2L のペアも入っていたか。そのペアがクロスの最後の手で入ったか
  let xcross: SolveStats["xcross"] = null;
  if (bounds && crossFace >= 0) {
    const ci = bounds[0];
    const slots = slotsFor(crossFace);
    const inAt = slots.filter((sl) => slotDone(states[ci], crossFace, sl));
    const done = ci > 0 && bounds[1] === ci;
    xcross = { done, slots: done ? inAt : [], withLastCrossMove: done && inAt.some((sl) => !slotDone(states[ci - 1], crossFace, sl)) };
  }

  // 無駄な回転: 同じ面の手が続いた所。クロスの最後の手と F2L の最初の手が同じ面
  const waste: Waste[] = [];
  const amt = (m: number) => (m % 3) + 1;
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && moveFace(ids[j]) === moveFace(ids[i])) j++;
    if (j - i >= 2) {
      const sum = ids.slice(i, j).reduce((s, m) => s + amt(m), 0) % 4;
      const net = sum ? MOVE_NAMES[moveFace(ids[i]) * 3 + sum - 1] : "";
      const isBoundary = !!bounds && bounds[0] > i && bounds[0] < j;
      waste.push({
        from: i,
        to: j,
        moves: ids.slice(i, j).map((m) => MOVE_NAMES[m]),
        net,
        saved: j - i - (sum ? 1 : 0),
        kind: isBoundary ? "cross-f2l" : "repeat",
        uncertain: moves.slice(i, j).some((m) => m.inferred),
      });
    }
    i = j;
  }
  const wasteMoves = waste.reduce((s, w) => s + w.saved, 0);

  const inferred = moves.filter((m) => m.inferred).length;
  const notExact = moves.filter((m) => !m.inferred && m.exact === false).length;
  if (inferred) notes.push(`推定の手 ${inferred} 手を含む（手数・区切りには入れ、その手を含む数字は不確か）`);
  return {
    counted: n,
    excludedAfterStop: all.length - n,
    cutBefore: input.cutBefore ?? 0,
    inferred,
    notExact,
    exactKnown,
    solved,
    start,
    end,
    ms,
    htm,
    qtm,
    target,
    overTarget: htm - target,
    tps: ms > 0 ? htm / (ms / 1000) : 0,
    phases,
    crossFace,
    firstPairMs,
    pauses,
    pauseTotalMs,
    pauseSureMs,
    gaps,
    tpsPerSecond,
    tpsRolling,
    regrips,
    regripsNet,
    regripsInCross,
    cross,
    xcross,
    waste,
    wasteMoves,
    notes,
  };
}
