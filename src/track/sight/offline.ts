// 新しい追跡器（tracker.ts）で精密解析: 始まりの状態から前向き、終わりの状態から後ろ向き（フレームを逆順に入れる。見つかる手は
// 逆向きの手）に同じ追跡器を通し、同じフレームで同じ状態・姿勢になった仮説どうしを、合計のコストがいちばん小さい所でつなぐ。
// 前向きだけで終わりの状態に着けば、それも候補にする。DOM もカメラも知らない
import { type CubeState, inverseMove } from "../../cube/model";
import { type MoveNode, type SightInput, type SightOptions, SightTracker, hashOf, movesOf } from "./tracker";

export interface SightDecoded {
  moves: MoveNode[];
  method: "forward" | "meet" | "none";
  cost: number;
}

export function decodeSight(frames: SightInput[], start: CubeState, end: CubeState, options: Partial<SightOptions> = {}): SightDecoded {
  const fwd = new SightTracker(start, options);
  const snaps: Map<number, { abs: number; tail: MoveNode | null; fc: number }>[] = [];
  for (const f of frames) {
    fwd.push(f);
    const m = new Map<number, { abs: number; tail: MoveNode | null; fc: number }>();
    for (const h of fwd.hyps) m.set(hashOf(h.pos, h.o), { abs: h.cost + fwd.offset, tail: h.tail, fc: h.frameCost });
    snaps.push(m);
  }
  let best: SightDecoded = { moves: [], method: "none", cost: Infinity };
  const fin = fwd.finish(end);
  if (fin) best = { moves: movesOf(fin.hyp.tail), method: "forward", cost: fin.hyp.cost + fwd.offset + fin.added * fwd.options.moveCost };
  const bwd = new SightTracker(end, options);
  for (let i = frames.length - 1; i >= 0; i--) {
    bwd.push(frames[i]);
    const m = snaps[i];
    for (const h of bwd.hyps) {
      const x = m.get(hashOf(h.pos, h.o));
      if (!x) continue;
      const total = x.abs + h.cost + bwd.offset - x.fc;
      if (total >= best.cost) continue;
      // 後ろ向きの手（終わりから見た順）を、前向きの順・向きに直す。時刻は、後ろ向きでその手の前の状態が見えたフレーム
      const back = movesOf(h.tail)
        .reverse()
        .map((n) => ({ ...n, move: inverseMove(n.move), t0: n.t, t: n.t0, prev: null }));
      best = { moves: [...movesOf(x.tail), ...back], method: "meet", cost: total };
    }
  }
  return best;
}
