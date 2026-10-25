// 推定した手順を、実際に回した速さと間で 3D に再生するための時間の対応（DOM を知らない）。
// 手 i は実時間 [start, end]（回し始め〜回し終わり）に回る。3D（cubing.js）の再生位置は手ごとに [pStart, pStart + pDur]
// で、間がない。実時間の T を 3D の再生位置に写す: 回している途中はその手の中を比例で進め、手と手の間は前の手の終わりで止める。
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

// 実時間 T → 3D の再生位置。pStart[i]・pDur[i] は 3D 側の手 i の開始位置と長さ
export function playerTimestamp(T: number, spans: Span[], pStart: number[], pDur: number[]): number {
  if (!spans.length || T <= spans[0].start) return 0;
  let i = 0;
  while (i + 1 < spans.length && spans[i + 1].start <= T) i++;
  const s = spans[i];
  if (T >= s.end) return pStart[i] + pDur[i];
  return pStart[i] + (pDur[i] * (T - s.start)) / (s.end - s.start);
}

// いま回している（または最後に回した）手の番号。手の前なら -1
export function moveAt(T: number, spans: Span[]): number {
  let i = -1;
  while (i + 1 < spans.length && spans[i + 1].start <= T) i++;
  return i;
}
