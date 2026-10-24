// 追跡エンジン: フレームの読み取り → 安定観測 → デコーダ → 結果。カメラも DOM も知らない。
// Worker の中でもテストの中でも同じコードが動く。
import { type CubeState, isSolved, VIEW } from "../cube/model";
import type { Lab } from "../vision/color";
import { ColorModel, type ColorModelOptions } from "./colorModel";
import { type DecoderOptions, MoveDecoder } from "./decoder";
import { FaceObserver, type FrameReading, type ObserverOptions } from "./observer";
import { DEFAULT_TIMING, type LoggedFrame, type MoveTiming, moveTiming } from "./timing";
import type { DecodedMove, Observation, TrackStatus } from "./types";

export interface EngineOptions {
  decoder: Partial<DecoderOptions>;
  observer: Partial<ObserverOptions>;
  colors: Partial<ColorModelOptions>;
  logMs: number; // 手の正確な時刻を求めるために残すフレームの記録（ms。Infinity で全部）
  keepObservations?: boolean; // 観測をすべて残す（ソルブ後の再構成で、前後両方向から解き直すため）
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
  timings: (MoveTiming | null)[]; // moves と同じ並び。フレームの記録から求めた開始・終了時刻（記録が残っていなければ null）
}

export class TrackerEngine {
  readonly colors: ColorModel;
  readonly observer: FaceObserver;
  readonly decoder: MoveDecoder;
  readonly frames: LoggedFrame[] = [];
  readonly observationLog: Observation[] = [];
  logMs: number;
  private keepObservations: boolean;

  constructor(start: CubeState, refs: Lab[], options: Partial<EngineOptions> = {}, orients?: number[]) {
    this.colors = new ColorModel(refs, options.colors);
    this.observer = new FaceObserver(this.colors, options.observer);
    this.decoder = new MoveDecoder(start, options.decoder, orients);
    this.logMs = options.logMs ?? 12000;
    this.keepObservations = !!options.keepObservations;
  }

  setOptions(options: Partial<EngineOptions>): void {
    if (options.decoder) this.decoder.setOptions(options.decoder);
    if (options.observer) Object.assign(this.observer.options, options.observer);
    if (options.colors) Object.assign(this.colors.options, options.colors);
    if (options.logMs !== undefined) this.logMs = options.logMs;
  }

  reset(state: CubeState, orients?: number[]): void {
    this.decoder.reset(state, orients);
    this.observer.reset();
  }

  push(frame: FrameReading): TrackUpdate | null {
    this.frames.push({ t: frame.t, faces: frame.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid, spread: f.spread, masked: f.masked })) });
    while (this.frames.length && frame.t - this.frames[0].t > this.logMs) this.frames.shift();
    const obs = this.observer.push(frame);
    if (!obs) return null;
    if (this.keepObservations) this.observationLog.push(obs);
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

  // 見えている面がすべて1色か（完成の見た目）。高速回転で追跡を見失っていても、タイマーを止められるように。
  // 2面以上が（手で隠れていないセルの）6枚以上読めて、どの面にも違う色が混ざっていないこと
  // 各面の各セルの最近傍の色（読めない・手で隠れたセルは -1）
  labelsOf(frame: FrameReading): number[][] {
    return frame.faces.map((f) => f.labs.map((lab, cell) => (f.valid[cell] && !f.masked?.[cell] ? this.colors.classify(lab).label : -1)));
  }

  looksSolved(frame: FrameReading, labels = this.labelsOf(frame)): boolean {
    let uniform = 0;
    for (let i = 0; i < frame.faces.length; i++) {
      let known = 0;
      let label = -1;
      for (let cell = 0; cell < 9; cell++) {
        const c = labels[i][cell];
        if (c < 0) continue;
        if (label >= 0 && c !== label) return false;
        label = c;
        known++;
      }
      if (known >= 6) uniform++;
    }
    return uniform >= 2;
  }

  // このフレームの見え方に最も合う姿勢（追跡の最良の状態と照合。中心の色でほぼ決まる）。
  // 3D 表示を毎フレームのキューブの向きに合わせるのに使う（観測を待たずに、持ち替えにすぐ追従する）
  frameOrient(frame: FrameReading, labels = this.labelsOf(frame)): number {
    const best = this.decoder.best();
    let bestO = best.orient;
    let bestCost = Infinity;
    for (let o = 0; o < 24; o++) {
      let cost = o === best.orient ? -0.5 : 0;
      for (let i = 0; i < frame.faces.length; i++) {
        const base = (o * 6 + frame.faces[i].slot) * 9;
        for (let cell = 0; cell < 9; cell++) {
          const c = labels[i][cell];
          if (c >= 0 && c !== best.state[VIEW[base + cell]]) cost += cell === 4 ? 3 : 1;
        }
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestO = o;
      }
    }
    return bestO;
  }

  // 手の開始・終了時刻（フレームの記録から）
  timing(m: DecodedMove): MoveTiming | null {
    if (!this.frames.length || (m.t0 ?? m.t) < this.frames[0].t) return null;
    return moveTiming(this.frames, m, { ...DEFAULT_TIMING, refs: this.colors.refs });
  }

  snapshot(obs?: Observation): TrackUpdate {
    const best = this.decoder.best();
    const moves = this.decoder.bestMoves();
    return {
      status: this.decoder.status,
      moves,
      timings: moves.map((m) => this.timing(m)),
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
