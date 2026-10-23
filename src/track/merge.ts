// 表示用: 同じ面を続けて素早く回した手（R R）を1手（R2）にまとめる。
// 半回転をゆっくり回すと、途中の 90° の状態が一瞬安定して見えて2手に分かれることがあるため。
import { moveFace } from "../cube/model";
import type { DecodedMove } from "./types";

export function mergeQuickRepeats(moves: DecodedMove[], windowMs = 450): DecodedMove[] {
  const out: DecodedMove[] = [];
  for (const m of moves) {
    const last = out[out.length - 1];
    if (last && moveFace(last.move) === moveFace(m.move) && m.t - last.t < windowMs) {
      const amount = ((last.move % 3) + 1 + (m.move % 3) + 1) % 4;
      out.pop();
      if (amount) out.push({ ...last, move: moveFace(m.move) * 3 + amount - 1, t: m.t, inferred: last.inferred || m.inferred });
      continue;
    }
    out.push(m);
  }
  return out;
}
