// タイマーの計測中に、完成したかを決める（DOM もカメラも知らない。tests/stopDetect.test.ts）。追跡の状態には頼らず、フレームの
// 見え方を ID で直接見る（src/track/homeView.ts の solvedView）:
//   A) 見えている面で読めたステッカーが全部「揃ったときの自分の場所」にいて、接し方で確かめられた面のまとまりで SOLVED_MIN 枚以上
//      読めたフレームが、SOLVED_HOLD_MS・SOLVED_HOLD_FRAMES 続いたとき（揃いと食い違うフレームが 1 枚でもあればやり直す。読めた数が
//      足りないだけのフレームは数えずに待つ）。止めた時刻は揃いが見え始めたフレーム
//   B) 追跡が揃った状態になり、そのフレームの見え方も揃いと食い違わない（TRACKED_MIN 枚以上が自分の場所にいる。1 面だけでもよい）とき
// 止める瞬間が少し遅れても、タイムは精密解析が録画から決める。早く止めない方を優先する
import { solvedView } from "../track/homeView";
import type { SightFrame } from "../track/sight";

export const SOLVED_MIN = 10;
export const SOLVED_HOLD_MS = 200;
export const SOLVED_HOLD_FRAMES = 2;
export const TRACKED_MIN = 5;
const TRACKED_VIEW_MS = 300; // 追跡の揃いと照らす見え方は、これより古くないもの

export class StopDetector {
  private since = -1; // 揃いが見え始めたフレームの時刻（-1 = 見えていない）
  private frames = 0;
  private last: { t: number; ok: boolean; home: number } | null = null;

  reset(): void {
    this.since = -1;
    this.frames = 0;
    this.last = null;
  }

  // 1 フレームの見え方。完成と決めたら止める時刻（揃いが見え始めたフレーム）、まだなら null
  frame(t: number, sight: SightFrame | undefined): number | null {
    if (!sight?.faces.length) return null;
    const v = solvedView(sight);
    if (v.read) this.last = { t, ok: v.ok, home: v.home };
    if (!v.ok) {
      this.since = -1;
      this.frames = 0;
      return null;
    }
    if (v.home < SOLVED_MIN) return null;
    if (this.since < 0) this.since = t;
    this.frames++;
    return this.frames >= SOLVED_HOLD_FRAMES && t - this.since >= SOLVED_HOLD_MS ? this.since : null;
  }

  // 追跡が揃った状態になった（t: その観測の時刻）。直近の見え方も揃いと食い違わなければ true
  trackedSolved(t: number): boolean {
    const l = this.last;
    return !!l && l.ok && l.home >= TRACKED_MIN && Math.abs(t - l.t) <= TRACKED_VIEW_MS;
  }
}
