// ソルブ後の精密解析: 録画した全フレームを1枚ずつ、リアルタイムより重い設定で認識・追跡し直す。
// 手順と、各手の開始・終了時刻（フレームの記録から求めた、誤差はフレーム間隔の半分程度）を出す。
// OpenCV のオブジェクトは呼び出し側が渡すので、Worker でもテスト（Node）でも同じコードが動く。
import { type CubeState, isSolved, solvedState, statesEqual } from "../cube/model";
import { type EngineOptions, TrackerEngine } from "../track/engine";
import { mergeQuickRepeats } from "../track/merge";
import type { TrackStatus } from "../track/types";
import type { Lab } from "./color";
import { type PatchFrame, facePatch, refineEnd, refineStart } from "./fineTiming";
import type { Pt } from "./homography";
import { DEFAULT_PIPELINE, type PipelineConfig, type PipelineMemory, processFrame } from "./pipeline";
import type { CV } from "./quads";
import type { PixelSource } from "./sampler";

export interface HandSample {
  t: number;
  hulls: Pt[][]; // 正規化座標（0..1）
}

export interface RefineInput {
  state: number[]; // 解析範囲の始まりの状態（スクランブル後）
  refs: Lab[];
  orients?: number[];
  from: number; // 解析する範囲（ms）
  to: number;
  startHint?: number; // 最初の手のおおよその時刻（リアルタイムの追跡から）。タイムの両端の画素を残す範囲を絞る
  hands?: HandSample[];
  engine?: Partial<EngineOptions>;
  pipeline?: Partial<PipelineConfig>;
}

export interface RefinedMove {
  move: number;
  orient: number;
  start: number; // 回し始め（ms）
  end: number; // 回し終わり（ms）
  inferred?: boolean;
  exact: boolean; // フレームから開始・終了を決められた
}

export interface RefineResult {
  moves: RefinedMove[];
  solved: boolean; // 最後に完成状態にたどり着いた
  start: number | null; // 最初の手の開始
  end: number | null; // 最後の手の終了
  frames: number;
  status: TrackStatus;
  inferred: number;
  forced: number; // 完成にたどり着くために最後に足した手の数（直接は見えていない）
  startUncertain: boolean; // 最初の手が直接見えておらず、開始時刻をフレームから決められなかった
  endUncertain: boolean; // 最後の手が直接見えておらず、終了時刻をフレームから決められなかった
  raw?: { move: number; t0?: number; t: number; start: number; end: number; inferred?: boolean }[]; // まとめる前の手（調査用）
}

// 重い設定: 全フレームを処理するので、1回の観測で起きる手は少ないが、取りこぼしを深く探し直せるように
export const REFINE_ENGINE: Partial<EngineOptions> = {
  decoder: { beamWidth: 64, maxMovesPerStep: 4, recoveryDepth: 5 },
  logMs: Infinity,
};

export class Refiner {
  readonly engine: TrackerEngine;
  private memory: { last: PipelineMemory | null } = { last: null };
  private config: PipelineConfig;
  private handIdx = 0;
  readonly patches: PatchFrame[] = [];
  readonly looks: { t: number; solved: boolean }[] = []; // フレームごとの「完成して見えるか」
  frames = 0;
  lastT = 0;

  constructor(
    private cv: CV | null,
    private input: RefineInput,
  ) {
    const opts = input.engine ?? {};
    this.engine = new TrackerEngine(Uint8Array.from(input.state), input.refs, {
      ...opts,
      decoder: { ...opts.decoder, ...REFINE_ENGINE.decoder },
      logMs: Infinity,
    }, input.orients);
    this.config = { ...DEFAULT_PIPELINE, ...input.pipeline, quads: { ...DEFAULT_PIPELINE.quads, ...(input.pipeline?.quads ?? {}) } };
  }

  // そのフレームの直前に検出された手（手の検出は 15Hz 程度なので、一番近い過去のもの）
  private handsAt(t: number, w: number, h: number): Pt[][] {
    const hs = this.input.hands;
    if (!hs?.length) return [];
    while (this.handIdx + 1 < hs.length && hs[this.handIdx + 1].t <= t) this.handIdx++;
    const cur = hs[this.handIdx];
    if (cur.t > t + 40 || t - cur.t > 250) return [];
    // 前後の検出の両方で隠すと、動いている指の取りこぼしが減る
    const next = hs[this.handIdx + 1];
    const hulls = next && next.t - t < 80 ? [...cur.hulls, ...next.hulls] : cur.hulls;
    return hulls.map((hull) => hull.map(([x, y]) => [x * w, y * h] as Pt));
  }

  // hands: 手の多角形（画像座標）を直接渡すとき。省略時は input.hands の履歴から
  push(img: PixelSource & { mat?: unknown }, t: number, hands?: Pt[][]): void {
    if (t < this.input.from || t > this.input.to) return;
    const r = processFrame(this.cv, img, t, this.config, this.memory, this.engine.colors.refs, hands ?? this.handsAt(t, img.width, img.height));
    const reading = { t, faces: r.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid, weight: f.weight, spread: f.spread, masked: f.masked })) };
    this.engine.push(reading);
    this.looks.push({ t, solved: reading.faces.length > 0 && this.engine.looksSolved(reading) });
    this.patches.push({ t, faces: r.faces.map((f) => facePatch(img, f)) });
    this.prunePatches(t);
    this.frames++;
    this.lastT = t;
  }

  // 画素のパッチ（1フレーム 10KB 程度）は、最初の手の前後と、直近の数秒（最後の手の前後）だけ残す
  private prunePatches(t: number): void {
    const hint = this.input.startHint;
    if (hint === undefined) return;
    const P = this.patches;
    let i = 0;
    while (i < P.length && P[i].t <= hint + 1500) i++;
    let j = i;
    while (j < P.length && P[j].t < t - 3000) j++;
    if (j - i > 30) P.splice(i, j - i);
  }

  // target: 最後の状態が分かっていれば（タイマーなら完成）、それにたどり着く仮説を選ぶ
  result(target: CubeState | null = solvedState()): RefineResult {
    const dec = this.engine.decoder;
    let moves = dec.bestMoves();
    let solved = isSolved(dec.best().state);
    let forced = 0;
    if (target && !statesEqual(dec.best().state, target)) {
      const fixed = dec.finish(target, this.lastT, 2);
      if (fixed) {
        forced = fixed.filter((m) => m.inferred && m.t === this.lastT).length;
        moves = fixed;
        solved = isSolved(target);
      }
    }
    const timed = moves.map((m) => {
      const tm = this.engine.timing(m);
      return { ...m, start: tm?.start ?? m.t0 ?? m.t, end: tm?.end ?? m.t, exact: !!tm?.exact };
    });
    // タイムの両端は画素の差で詰める（色の読みより早く動きを拾える）
    const first = timed[0];
    const last = timed[timed.length - 1];
    let endUncertain = !!last?.inferred;
    if (first?.exact && !first.inferred) first.start = refineStart(this.patches, first, first.start) ?? first.start;
    if (last?.exact && !last.inferred) last.end = refineEnd(this.patches, last, last.end) ?? last.end;
    else if (last?.inferred && solved) {
      // 最後の手が見えていない（完成にたどり着くために足した手）: 直接見えた最後の手の後で、
      // 完成して見え始めたフレームを回し終わりとする
      const seen = [...timed].reverse().find((m) => !m.inferred);
      const after = seen ? seen.end : this.input.from;
      const i = this.looks.findIndex((x, k) => x.t > after && x.solved && this.looks[k + 1]?.solved !== false);
      if (i > 0) {
        last.end = (this.looks[i - 1].t + this.looks[i].t) / 2;
        last.start = Math.min(last.start, last.end);
        endUncertain = false;
      }
    }
    const merged = mergeQuickRepeats(timed).map((m) => ({ move: m.move, orient: m.orient, start: m.start, end: Math.max(m.start, m.end), exact: m.exact, ...(m.inferred ? { inferred: true } : {}) }));
    return {
      moves: merged,
      solved,
      start: merged.length ? merged[0].start : null,
      end: merged.length ? merged[merged.length - 1].end : null,
      frames: this.frames,
      status: dec.status,
      inferred: merged.filter((m) => m.inferred).length,
      forced,
      startUncertain: !!first?.inferred,
      endUncertain,
      raw: timed.map((m) => ({ move: m.move, t0: m.t0, t: m.t, start: m.start, end: m.end, inferred: m.inferred })),
    };
  }
}
