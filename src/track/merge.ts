// 表示用: 同じ面を続けて素早く回した手（R R）を1手（R2）にまとめる。
// 半回転をゆっくり回すと、途中の 90° の状態が一瞬安定して見えて2手に分かれることがあるため。
// 開始・終了時刻を持つ手（start / end）は、まとめた手の開始を前の手、終了を後の手から取る。前の手の回し終わりから
// 止まらずに（gapMs 以内に）次の手を回し始めていれば、観測の間隔が空いていても（カメラが遅い）まとめる。
import { moveFace } from "../cube/model";
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

// 打ち消し合う手（R2 R2・F … F' で間に何もない）を取り除く。人が回してすぐ戻すことはまれで、ほとんどは回転途中の
// 見え方や指の誤読から出た雑音。取り除くと間の手どうしが隣り合うので、続けて打ち消し合えばそれも取り除く
// （F R2 R2 F' → F F' → なし）。間に別の手があるもの（R L R'）は、人が回すこともあるので残す
export function cancelInverses<T extends DecodedMove>(moves: T[]): T[] {
  const out: T[] = [];
  const amount = (m: number) => (m % 3) + 1; // 1 = 90°, 2 = 180°, 3 = -90°
  for (const m of moves) {
    const f = moveFace(m.move);
    const j = out.length - 1;
    if (j >= 0 && moveFace(out[j].move) === f && (amount(out[j].move) + amount(m.move)) % 4 === 0) {
      out.splice(j, 1);
      continue;
    }
    out.push(m);
  }
  return out;
}
