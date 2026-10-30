// 推定した手順の時刻（DOM を知らない）。3D（src/aruco/timedCube.tsx）は、動画の時刻 T までに回し始めた手を決まった速さで回す
import type { DecodedMove } from "../track/types";

export interface Span {
  start: number; // 回し始め（実時間 ms）
  end: number; // 回し終わり
}

// 回し始めが分からない手（推定した手など）の長さ
const DEFAULT_TURN_MS = 120;

// 手の時刻を、重ならず前後が逆にならない区間にする
export function moveSpans(moves: DecodedMove[]): Span[] {
  const out: Span[] = [];
  let prevEnd = -Infinity;
  for (const m of moves) {
    let start = m.t0 ?? m.t - DEFAULT_TURN_MS;
    let end = m.t;
    start = Math.max(start, prevEnd);
    if (end < start + 1) end = start + 1;
    out.push({ start, end });
    prevEnd = end;
  }
  return out;
}

// いま回している（または最後に回した）手の番号。手の前なら -1
export function moveAt(T: number, spans: Span[]): number {
  let i = -1;
  while (i + 1 < spans.length && spans[i + 1].start <= T) i++;
  return i;
}
