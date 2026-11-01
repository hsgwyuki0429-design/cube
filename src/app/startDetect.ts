// タイマーのインスペクション中に、回し始めたかを決める（DOM もカメラも知らない。tests/startDetect.test.ts）。
// 回し始めたと決めるのは:
//   A) 最初の手が確定し（有力な仮説がすべてその手で一致）、その層が動いたことをフレームから見つけたとき（マーカーの位置が動いた）
//   B) 一番合う仮説の状態がスクランブルの状態から外れたまま START_HOLD_MS・START_HOLD_OBS 続いたとき
//      （最初の手を指で隠した・速すぎて読めなかった・層が見えない面の手）
// 誤読を 2 手などで説明した仮説は、次の観測で読みが戻ると元の状態に戻る。手が足されただけで始めていた間は、動いていないのに
// 始まることがあった。開始の時刻は、どちらも外れ始めた所まで遡る（正確な開始は、止めた後の精密解析で録画から決め直す）
import { type CubeState, statesEqual } from "../cube/model";
import type { TrackUpdate } from "../track/engine";

export const START_HOLD_MS = 350;
export const START_HOLD_OBS = 2;
// インスペクション中に、追跡が見失って見えている色に作り変えた（TrackUpdate.base）後は、外れたまま続いても誤読かもしれないので
// これだけ続くまで待つ（作り変えた状態は見えていない面が分からないので、スクランブルの状態とずれて見えやすい）
export const START_HOLD_SNAPPED_MS = 1500;
export const LOOKBACK_MS = 300; // 層の動き出しが分からないとき、外れ始めた観測からこれだけ前までを回し始めとみる（1 手の長さほど）
export const LOOKBACK_MAX_MS = 600; // 層の動き出しが分かっても、これより前には遡らない

export class StartDetector {
  private deviatedAt = -1; // 外れ始めた観測の時刻（-1 = 外れていない）
  private deviatedObs = 0;

  private readyBase = 0; // スクランブルの状態になったときの作り変えの回数

  // baseN: スクランブルの状態になったときの作り変えの回数（TrackUpdate.base.n）
  reset(baseN?: number): void {
    this.deviatedAt = -1;
    this.deviatedObs = 0;
    if (baseN !== undefined) this.readyBase = baseN;
  }

  // 回し始めたら開始の時刻、まだなら null。readyMoves: スクランブルの状態になったときの追跡の手の数
  push(u: Pick<TrackUpdate, "state" | "moves" | "confirmed" | "timings" | "observations" | "observation"> & { base?: TrackUpdate["base"] }, target: CubeState | null, readyMoves: number): number | null {
    const away = !(target && statesEqual(Uint8Array.from(u.state), target));
    if (!away || u.observations === 0) {
      this.reset();
      return null;
    }
    if (this.deviatedAt < 0) this.deviatedAt = u.observation.t;
    this.deviatedObs++;
    const first = u.moves.length > readyMoves ? u.moves[readyMoves] : null;
    const timing = first ? u.timings?.[readyMoves] : null;
    const confirmedMove = !!first && u.confirmed > readyMoves && !first.inferred && !!timing?.moved;
    const snapped = (u.base?.n ?? 0) !== this.readyBase;
    const held = this.deviatedObs >= START_HOLD_OBS && u.observation.t - this.deviatedAt >= (snapped ? START_HOLD_SNAPPED_MS : START_HOLD_MS);
    if (!confirmedMove && !held) return null;
    // 回し始め: 層が動き出したフレームが分かればそこ（それでも外れ始めた観測から LOOKBACK_MAX_MS まで）。分からなければ外れ始めた
    // 観測の LOOKBACK_MS 前まで（手の t0 は前の読みが最後に見えた時刻なので、指で隠していた間が長いとその分だけ前になり、
    // タイムが長くなっていた。正確な開始は、止めた後の精密解析で録画から決め直す）
    const lo = this.deviatedAt - (timing?.exact ? LOOKBACK_MAX_MS : LOOKBACK_MS);
    const guess = timing?.exact ? timing.start : (first?.t0 ?? this.deviatedAt);
    return Math.min(this.deviatedAt, Math.max(lo, guess));
  }
}
