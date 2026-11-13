// 前向き（始まりの状態から）と後ろ向き（終わりの状態から、時刻を逆にした表で）の両方で探し、同じフレームで同じ状態になった仮説どうしを
// 合計コストの小さい所でつなぐ。速い連続（数手ぶん読めるフレームがない）は、前からは前半、後ろからは後半が決めやすい。
// DOM もカメラも知らない
import { type CubeState, inverseMove } from "../../cube/model";
import { type PieceMove, type SolveOptions, type SolveResult, solvePieces } from "./solve";
import { type PieceTable, reverseTable } from "./table";

export interface MeetResult extends SolveResult {
  method: "meet" | "forward" | "backward" | "none";
  meetAt: number; // つないだフレームの時刻（つながなければ NaN）
  forwardMs: number;
  backwardMs: number;
}

export function solveBoth(table: PieceTable, start: CubeState, end: CubeState, options: Partial<SolveOptions> = {}): MeetResult {
  const began = performance.now();
  const collect = options.collect ?? 48;
  const n = table.n;
  const fw = solvePieces(table, start, end, { ...options, collect });
  const mid = performance.now();
  const bw = solvePieces(reverseTable(table), end, start, { ...options, collect, allow: undefined, trace: undefined });
  const done = performance.now();
  // つなぐ所
  let best = Infinity;
  let bestF = -1;
  let fPath = -1;
  let bPath = -1;
  for (let f = 0; f < n; f++) {
    const B = bw.sets![n - 1 - f];
    if (!B.length) continue;
    const map = new Map<string, { cost: number; path: number }>();
    for (const b of B) map.set(b.key, b);
    for (const a of fw.sets![f]) {
      const b = map.get(a.key);
      if (b && a.cost + b.cost < best) {
        best = a.cost + b.cost;
        bestF = f;
        fPath = a.path;
        bPath = b.path;
      }
    }
  }
  const moveOf = (m: { move: number; frame: number; hidden: boolean }): PieceMove => {
    const fr = Math.min(m.frame, n - 1);
    return { move: m.move, frame: m.frame, t0: m.frame > 0 ? table.t[Math.min(m.frame - 1, n - 1)] : table.t[0], t: table.t[fr], orient: Math.max(0, table.orient[fr]), ...(m.hidden ? { inferred: true } : {}) };
  };
  const base = { expanded: fw.expanded + bw.expanded, ms: performance.now() - began, forwardMs: mid - began, backwardMs: done - mid };
  // 前向きだけ・後ろ向きだけで届いたものとも比べる
  const fwCost = fw.reachedEnd ? fw.cost : Infinity;
  const bwCost = bw.reachedEnd ? bw.cost : Infinity;
  if (bestF >= 0 && best <= fwCost && best <= bwCost) {
    const head = fw.pathMoves!(fPath).map(moveOf);
    // 後ろ向きの手: 逆の表のフレーム g の前の間 = 元の表のフレーム n − g の前の間。手は逆向き、順番も逆
    const tail = bw.pathMoves!(bPath).map((m) => moveOf({ move: inverseMove(m.move), frame: n - m.frame, hidden: m.hidden })).reverse();
    return { ...base, moves: [...head, ...tail], reachedEnd: true, cost: best, mismatch: best - head.length - tail.length, state: end, method: "meet", meetAt: table.t[bestF] };
  }
  if (fw.reachedEnd && fwCost <= bwCost) return { ...fw, ...base, method: "forward", meetAt: Number.NaN, sets: undefined, pathMoves: undefined };
  if (bw.reachedEnd) {
    const moves = bw.moves.map((m) => moveOf({ move: inverseMove(m.move), frame: n - m.frame, hidden: !!m.inferred })).reverse();
    return { ...base, moves, reachedEnd: true, cost: bw.cost, mismatch: bw.mismatch, state: end, method: "backward", meetAt: Number.NaN };
  }
  return { ...fw, ...base, method: "none", meetAt: Number.NaN, sets: undefined, pathMoves: undefined };
}
