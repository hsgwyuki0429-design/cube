// 前のタイマーの開始・停止の判定（2026-11-21 まで。src/app/startDetect.ts・timer.ts の onFrame）。timerEdges.debug.test.ts で今の判定と並べる
import { type CubeState, statesEqual } from "../../../src/cube/model";
import type { TrackUpdate } from "../../../src/track/engine";

export const START_HOLD_MS = 350;
export const START_HOLD_OBS = 2;
// インスペクション中に、追跡が見失って見えている色に作り変えた（TrackUpdate.base）後は、外れたまま続いても誤読かもしれないので
// これだけ続くまで待つ（作り変えた状態は見えていない面が分からないので、スクランブルの状態とずれて見えやすい）
export const START_HOLD_SNAPPED_MS = 1500;
export const LOOKBACK_MS = 300; // 層の動き出しが分からないとき、外れ始めた観測からこれだけ前までを回し始めとみる（1 手の長さほど）
export const LOOKBACK_MAX_MS = 600; // 層の動き出しが分かっても、これより前には遡らない

export class OldStartDetector {
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

// 前の停止: 追跡が揃った状態（u.solved）か、見えている面がすべて 1 色（2 面以上・各 6 マス以上。engine.looksSolved）のフレームが
// 3 枚続き、追跡が確か（tracking）ならさらに 1 秒続いたとき
export class OldStopDetector {
  private run = 0;
  private since = 0;
  reset(): void {
    this.run = 0;
  }
  frame(t: number, looksSolved: boolean | undefined, status: string | undefined): number | null {
    if (looksSolved === undefined || !looksSolved) {
      this.run = 0;
      return null;
    }
    if (!this.run) this.since = t;
    this.run++;
    return this.run >= 3 && (status !== "tracking" || t - this.since > 1000) ? this.since : null;
  }
}
