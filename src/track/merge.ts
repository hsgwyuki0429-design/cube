// 表示用: 同じ面を続けて素早く回した手（R R）を1手（R2）にまとめる。
// 半回転をゆっくり回すと、途中の 90° の状態が一瞬安定して見えて2手に分かれることがあるため。
// 開始・終了時刻を持つ手（start / end）は、まとめた手の開始を前の手、終了を後の手から取る。
import { moveFace } from "../cube/model";
import type { DecodedMove } from "./types";

export function mergeQuickRepeats<T extends DecodedMove & { start?: number }>(moves: T[], windowMs = 450): T[] {
  const out: T[] = [];
  for (const m of moves) {
    const last = out[out.length - 1];
    if (last && moveFace(last.move) === moveFace(m.move) && m.t - last.t < windowMs) {
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
