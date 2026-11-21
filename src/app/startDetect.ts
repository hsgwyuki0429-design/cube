// タイマーのインスペクション中に、回し始めたかを決める（DOM もカメラも知らない。tests/startDetect.test.ts）。
// 回し始めたと決めるのは、次の 2 つが揃ったとき:
//   1) フレームの見え方が、スクランブルの状態から ID で見て確かに変わった（src/track/homeView.ts の changedFrom: 面ごとにいちばん合う
//      置き方で、1 つの面で CHANGE_MIN_MISMATCH 枚以上合わないフレームが CHANGE_MIN_FRAMES 枚続いた）。持ち替え（全部の ID が一緒に
//      動く）は変化にならない。スクランブルの状態がそのまま見えたフレーム（SAME_MIN_READ 枚以上読めて全部合う）があればやり直す
//      （1 フレームだけの読み違い）。追跡の仮説も作り変えも見ない
//   2) 追跡の手のどれかで、その層が動いたのをフレームで見た（MoveTiming.moved: 層の側面のマーカーが本体の格子からずれた。持ち替えでは
//      格子ごと動くのでずれない）
// 前の判定（追跡の状態がスクランブルの状態から外れたまま 350ms・2 観測、または確定した最初の手）は、誤読を手で説明した仮説・作り変えで
// 回していないのに始まることがあった（docs/history.md の「タイマーの開始と停止を ID で見る」）。開始が少し遅れても、タイムは精密解析が
// 録画から決め直す。早く始めない方を優先する
import type { CubeState } from "../cube/model";
import { changedFrom } from "../track/homeView";
import type { SightFrame } from "../track/sight";
import type { TrackUpdate } from "../track/engine";

export const CHANGE_MIN_MISMATCH = 2;
export const CHANGE_MIN_FRAMES = 2;
export const SAME_MIN_READ = 6;
export const LOOKBACK_MS = 300; // 層の動き出しが分からないとき、変わり始めたフレームからこれだけ前までを回し始めとみる（1 手の長さほど）
export const LOOKBACK_MAX_MS = 600; // 層の動き出しが分かっても、変わり始めたフレームからこれより前には遡らない

export class StartDetector {
  private changedAt = -1; // 変わり始めたフレームの時刻（-1 = 変わっていない）
  private changedFrames = 0;

  reset(): void {
    this.changedAt = -1;
    this.changedFrames = 0;
  }

  // 1 フレームの見え方を、スクランブルの状態と照らす
  frame(t: number, sight: SightFrame | undefined, target: CubeState | null): void {
    if (!target || !sight?.faces.length) return;
    const v = changedFrom(sight, target);
    if (v.worst >= CHANGE_MIN_MISMATCH) {
      if (this.changedAt < 0) this.changedAt = t;
      this.changedFrames++;
    } else if (v.mismatch === 0 && v.read >= SAME_MIN_READ) this.reset();
  }

  get changed(): boolean {
    return this.changedFrames >= CHANGE_MIN_FRAMES;
  }

  // 回し始めたら開始の時刻、まだなら null。readyMoves: スクランブルの状態になったときの追跡の手の数
  push(u: Pick<TrackUpdate, "moves" | "timings">, readyMoves: number): number | null {
    if (!this.changed) return null;
    // 層が動いたのを見た手（変わり始めたより前に止まった手は、スクランブルの状態になる前の手の読み違い）
    let k = -1;
    for (let i = readyMoves; i < u.moves.length && k < 0; i++) {
      const tm = u.timings?.[i];
      if (!u.moves[i].inferred && tm?.moved && tm.end >= this.changedAt - LOOKBACK_MAX_MS) k = i;
    }
    if (k < 0) return null;
    // 回し始め: 最初に外れた手の層が動き出したフレームが分かればそこ（変わり始めたフレームから LOOKBACK_MAX_MS まで）。分からなければ
    // その手の t0（前の読みが最後に見えた時刻）を、変わり始めたフレームの LOOKBACK_MS 前まで。スクランブルを案内と違えて回していた
    // （最初から変わって見える）ときは、変わり始めたフレームではなく層の動きに合わせる。正確な開始は、止めた後の精密解析で決め直す
    const first = u.moves[readyMoves];
    const timing = u.timings?.[readyMoves];
    const exact = !!timing?.exact;
    const guess = exact ? timing!.start : (first?.t0 ?? this.changedAt);
    return Math.max(this.changedAt - (exact ? LOOKBACK_MAX_MS : LOOKBACK_MS), guess);
  }
}
