// 追跡エンジン: フレームの読み取り → 安定観測 → デコーダ → 結果。カメラも DOM も知らない。
// Worker の中でもテストの中でも同じコードが動く。
import { type CubeState, isSolved, VIEW } from "../cube/model";
import type { Lab } from "../vision/color";
import { ColorModel, type ColorModelOptions } from "./colorModel";
import { type DecoderOptions, MoveDecoder } from "./decoder";
import { FaceObserver, type FrameReading, type ObserverOptions } from "./observer";
import type { DecodedMove, Observation, TrackStatus } from "./types";

export interface EngineOptions {
  decoder: Partial<DecoderOptions>;
  observer: Partial<ObserverOptions>;
  colors: Partial<ColorModelOptions>;
}

export interface TrackUpdate {
  status: TrackStatus;
  moves: DecodedMove[]; // 最良仮説の手順（開始から）
  confirmed: number; // 先頭から何手目までが確定か
  state: number[]; // 最良仮説のキューブ状態
  orient: number;
  solved: boolean;
  margin: number;
  obsCost: number;
  observations: number;
  recoveries: number;
  refs: Lab[]; // 適応後の代表色
  observation: { t: number; faces: { slot: number; labels: number[] }[] };
}

export class TrackerEngine {
  readonly colors: ColorModel;
  readonly observer: FaceObserver;
  readonly decoder: MoveDecoder;

  constructor(start: CubeState, refs: Lab[], options: Partial<EngineOptions> = {}, orients?: number[]) {
    this.colors = new ColorModel(refs, options.colors);
    this.observer = new FaceObserver(this.colors, options.observer);
    this.decoder = new MoveDecoder(start, options.decoder, orients);
  }

  setOptions(options: Partial<EngineOptions>): void {
    if (options.decoder) this.decoder.setOptions(options.decoder);
    if (options.observer) Object.assign(this.observer.options, options.observer);
    if (options.colors) Object.assign(this.colors.options, options.colors);
  }

  reset(state: CubeState, orients?: number[]): void {
    this.decoder.reset(state, orients);
    this.observer.reset();
  }

  push(frame: FrameReading): TrackUpdate | null {
    const obs = this.observer.push(frame);
    if (!obs) return null;
    return this.observe(obs, frame);
  }

  observe(obs: Observation, frame?: FrameReading): TrackUpdate {
    this.decoder.observe(obs);
    const best = this.decoder.best();
    // デコーダが確信していて、観測とよく合っているときだけ代表色を寄せる
    if (frame && this.decoder.status === "tracking" && best.obsCost < 0.5 && this.decoder.margin() > 1.5) {
      for (const f of frame.faces) {
        f.labs.forEach((lab, cell) => {
          if (!f.valid[cell]) return;
          this.colors.adapt(lab, best.state[VIEW[(best.orient * 6 + f.slot) * 9 + cell]]);
        });
      }
    }
    return this.snapshot(obs);
  }

  snapshot(obs?: Observation): TrackUpdate {
    const best = this.decoder.best();
    return {
      status: this.decoder.status,
      moves: this.decoder.bestMoves(),
      confirmed: this.decoder.confirmedCount(),
      state: Array.from(best.state),
      orient: best.orient,
      solved: isSolved(best.state),
      margin: this.decoder.margin(),
      obsCost: this.decoder.lastObservationCost,
      observations: this.decoder.observations,
      recoveries: this.decoder.recoveries,
      refs: this.colors.refs.map((r) => [...r] as Lab),
      observation: { t: obs?.t ?? 0, faces: (obs?.faces ?? []).map((f) => ({ slot: f.slot, labels: Array.from(f.labels) })) },
    };
  }
}
