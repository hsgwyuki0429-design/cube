// 回して見せた手・追跡が数えた手を、本当の手（精密解析の手）に結びつける（liveReplay・liveLog で同じ物差し）
import { moveFace } from "../../../src/cube/model";
import type { RefineResult } from "../../../src/vision/refine";
import type { SimTurn } from "../../liveShowSim";

// 回して見せた手を本当の手（精密解析の手）に結びつける: 同じ面で、本当の手の回し始め 300ms 前〜回し終わり 1 秒後に回し始めたもの。
// 本当の手 1 つに結びつけるのは 1 つだけ。返すのは結びつかなかった手と、回して見せた本当の手の数
export function matchTurns(turns: SimTurn[], res: RefineResult, s0: number, s1: number, exact = false): { fake: SimTurn[]; real: number; truth: number } {
  const truth = res.moves.filter((m) => m.end >= s0 && m.start <= s1);
  const used = new Set<number>();
  const fake: SimTurn[] = [];
  for (const a of turns) {
    const j = truth.findIndex((m, k) => !used.has(k) && (exact ? m.move === a.move : moveFace(m.move) === moveFace(a.move)) && a.t >= m.start - 300 && a.t <= m.end + 1000);
    if (j >= 0) used.add(j);
    else fake.push(a);
  }
  return { fake, real: used.size, truth: truth.length };
}

