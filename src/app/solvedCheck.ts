// 「揃った状態から開始」の後に、本当に揃っているかを確かめる（タイマーの checking。src/app/timer.ts）。DOM もカメラも知らない。
// 揃った状態から追跡を始め、見えている色に合わせた作り変え（src/track/snap.ts）を使う。見えたステッカーが揃った状態と合えば
// （2 面ほど: SOLVED_SEEN 枚）すぐスクランブルへ。合わなければ（作り変えた・揃っていない状態になった・3D だけ作り変えた）、
// センター以外の 48 枚を全部、最後に作り変えた後に読めるまで待つ（6 面を見せてもらう）。作り変えより前に見たステッカーは、
// 作り変えで動いたかもしれないので数えない。読めたかは追跡のマスごとの「最後に直接見た時刻」（CellBelief.seenAt）で数える
// （そのマスにいまあるステッカーを、読みと合う所で見た時刻。最後に動かした後で、有力な仮説がそろってそう見ているものだけ）
import { isSolved } from "../cube/model";
import { analyzeState } from "../cube/pattern";
import { CERTAIN, type TrackUpdate } from "../track/engine";

export const CHECK_STICKERS = 48;
export const SOLVED_SEEN = 16;

export interface CheckMemo {
  t0: number; // 確かめ始めた観測の時刻
  base0: number; // そのときの作り変えの回数
  unsolved: boolean; // 揃っていないように見えた（一度見えたら戻さない）
}

export interface CheckStep {
  unsolved: boolean;
  seen: number; // 読めたステッカー（センター以外）
  left: number;
  ready: boolean; // この状態からスクランブルを作ってよい
}

export function checkStep(u: TrackUpdate, memo: CheckMemo | null): { memo: CheckMemo; step: CheckStep } {
  const m: CheckMemo = memo ?? { t0: u.observation.t, base0: u.base?.n ?? 0, unsolved: false };
  const snapped = (u.base?.n ?? 0) > m.base0;
  const state = Uint8Array.from(u.state);
  m.unsolved = m.unsolved || snapped || !!u.view || !isSolved(state);
  const since = snapped ? Math.max(m.t0, u.base!.t) : m.t0;
  let seen = 0;
  for (let f = 0; f < 54; f++) {
    if (f % 9 === 4) continue;
    const at = u.cells.seenAt[f];
    if (at >= since && at >= u.cells.movedAt[f] && u.cells.certainty[f] >= CERTAIN) seen++;
  }
  const left = CHECK_STICKERS - seen;
  const ready = u.status === "tracking" && (m.unsolved ? left === 0 && !u.view && !analyzeState(state).problems.length : seen >= SOLVED_SEEN);
  return { memo: m, step: { unsolved: m.unsolved, seen, left, ready } };
}
