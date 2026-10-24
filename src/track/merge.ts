// 表示用: 同じ面を続けて素早く回した手（R R）を1手（R2）にまとめる。
// 半回転をゆっくり回すと、途中の 90° の状態が一瞬安定して見えて2手に分かれることがあるため。
// 開始・終了時刻を持つ手（start / end）は、まとめた手の開始を前の手、終了を後の手から取る。前の手の回し終わりから
// 止まらずに（gapMs 以内に）次の手を回し始めていれば、観測の間隔が空いていても（カメラが遅い）まとめる。
import { OPPOSITE, moveFace } from "../cube/model";
import type { DecodedMove } from "./types";

export function mergeQuickRepeats<T extends DecodedMove & { start?: number; end?: number }>(moves: T[], windowMs = 450, gapMs = 100): T[] {
  const out: T[] = [];
  for (const m of moves) {
    const last = out[out.length - 1];
    const continuous = last?.end !== undefined && m.start !== undefined && m.start - last.end < gapMs;
    if (last && moveFace(last.move) === moveFace(m.move) && (m.t - last.t < windowMs || continuous)) {
      const amount = ((last.move % 3) + 1 + (m.move % 3) + 1) % 4;
      out.pop();
      if (amount) {
        const merged: T = { ...m, move: moveFace(m.move) * 3 + amount - 1, orient: last.orient, inferred: last.inferred || m.inferred };
        if (last.t0 !== undefined) merged.t0 = last.t0;
        if (last.start !== undefined) merged.start = last.start;
        if (!merged.inferred) delete merged.inferred;
        out.push(merged);
      }
      continue;
    }
    out.push(m);
  }
  return out;
}


// 再構成の結果を整える: 同じ面の手が続いたら 1 手にまとめ（R R → R2、U2 U' → U）、打ち消し合えば取り除く
// （R2 R2・F … F' → なし。取り除いて隣り合ったものも続けて）。反対の面の手は順番を入れ替えても同じなので、
// 1 手挟まっていてもまとめる（L R' L' → R'）。回転途中の見え方や指の誤読から、1 つの手が分かれて読まれたり、
// 回して戻す雑音が入ったりする。人が同じ面を続けて回すのは 180° を 2 回に分けたときくらいなので、まとめても失うものは少ない
export function simplifyMoves<T extends DecodedMove>(moves: T[]): T[] {
  const out: T[] = [];
  const amount = (m: number) => (m % 3) + 1; // 1 = 90°, 2 = 180°, 3 = -90°
  for (const m of moves) {
    const f = moveFace(m.move);
    let j = out.length - 1;
    if (j >= 1 && moveFace(out[j].move) === OPPOSITE[f] && moveFace(out[j - 1].move) === f) j--;
    if (j >= 0 && moveFace(out[j].move) === f) {
      const sum = (amount(out[j].move) + amount(m.move)) % 4;
      if (!sum) {
        out.splice(j, 1);
        continue;
      }
      const a = out[j];
      const merged: T = { ...m, move: f * 3 + sum - 1, orient: a.orient, inferred: a.inferred || m.inferred };
      if (a.t0 !== undefined) merged.t0 = a.t0;
      if (!merged.inferred) delete merged.inferred;
      out[j] = merged;
      continue;
    }
    out.push(m);
  }
  return out;
}
