// 高速回転（〜10TPS）のシミュレーション: 正確なタイムスタンプのフレーム（30/60fps）を、回転途中の層・
// モーションブラー・手の揺れ・指の遮蔽つきで描き、本物の認識パイプラインと追跡エンジンに通す。
import type { Vec3 } from "../src/cube/model";
import { type CubeState, applyMove, applyMoves, invertMoves, isSolved, solvedState, statesEqual } from "../src/cube/model";
import { type EngineOptions, TrackerEngine } from "../src/track/engine";
import type { DecodedMove } from "../src/track/types";
import { type Lab, rgbToLab } from "../src/vision/color";
import { processTracked } from "../src/vision/roi";
import { DEFAULT_PIPELINE, type PipelineConfig, processFrame } from "../src/vision/pipeline";
import { type RefineResult, Refiner } from "../src/vision/refine";
import type { CV } from "../src/vision/quads";
import { type SceneOptions, scene } from "./realism";
import { PALETTE, averageImages, axisAngle, renderCube } from "./render";
import { ALL_MOVES, canonical, editDistance, randomMove, rng, scrambled } from "./sim";

export const REFS: Lab[] = PALETTE.map(([r, g, b]) => rgbToLab(r * 0.85, g * 0.85, b * 0.85));

export interface SpeedOptions {
  seed: number;
  tps: number;
  fps: number;
  moves: number;
  eye?: Vec3;
  exposureMs?: number; // 露光時間（モーションブラー）
  hands?: boolean;
  maskHands?: boolean; // 指をアプリの手検出のようにマスクする（既定 true）
  wobble?: boolean;
  solveTo?: boolean; // 完成の手前から始めて完成で終わる（タイム計測の試験）
  engine?: Partial<EngineOptions>;
  pipeline?: Partial<PipelineConfig>;
  gap?: number;
  width?: number;
  every?: number; // k フレームに1枚だけ処理する（処理が追いつかない端末のリアルタイム追跡の再現）
  scene?: SceneOptions; // 実物らしい条件（艶の映り込み・色合い・持つ指）。指定すると円の指の代わりに使う
  onFrame?: (t: number, img: { data: Uint8ClampedArray; width: number; height: number }, hands: [number, number][][]) => void; // 調査用
  refine?: boolean; // 精密解析（Refiner）にも全フレームを通す
  refineFrom?: number; // 精密解析の範囲の始まり（ms。既定 0）
  tracked?: boolean; // リアルタイムの追跡をアプリと同じく、直前の位置の周りだけで処理する（processTracked）
}

export interface SpeedResult {
  accuracy: number;
  final: boolean;
  solved: boolean;
  truth: number[];
  decoded: DecodedMove[];
  startTruth: number; // 最初の手が動き始めた時刻
  endTruth: number; // 最後の手が終わった時刻
  frames: number;
  engine: TrackerEngine;
  refined?: RefineResult & { accuracy: number };
  refiner?: Refiner;
}

const ease = (k: number) => k * k * (3 - 2 * k);

export function simulate(cv: CV, o: SpeedOptions): SpeedResult {
  const rnd = rng(o.seed);
  const period = 1000 / o.tps;
  const duration = Math.min(period * 0.85, 170);
  const truth: number[] = [];
  for (let i = 0; i < o.moves; i++) truth.push(randomMove(rnd, truth[truth.length - 1], ALL_MOVES));
  const start: CubeState = o.solveTo ? applyMoves(solvedState(), invertMoves(truth)) : scrambled(rnd);
  const states = [start];
  for (const m of truth) states.push(applyMove(states[states.length - 1], m));
  const lead = 600;
  const startTruth = lead;
  const endTruth = lead + (o.moves - 1) * period + duration;
  const total = endTruth + 700;

  const engine = new TrackerEngine(start, REFS, o.engine);
  const refiner = o.refine ? new Refiner(cv, { state: Array.from(start), refs: REFS, from: o.refineFrom ?? 0, to: Infinity, startHint: lead, engine: o.engine, pipeline: o.pipeline }) : null;
  const memory = { last: null };
  const eye = o.eye ?? [0.8, 4.5, 9];
  const w = o.width ?? 640;
  const h = Math.round((w * 3) / 4);
  const occludersAt = (t: number) => [
    { center: [w * (0.32 + 0.06 * Math.sin(t / 150)), h * (0.62 + 0.05 * Math.cos(t / 210))] as [number, number], radius: w * 0.05, color: [215, 165, 135] as [number, number, number] },
    { center: [w * (0.68 + 0.05 * Math.cos(t / 170)), h * (0.6 + 0.06 * Math.sin(t / 190))] as [number, number], radius: w * 0.045, color: [205, 150, 125] as [number, number, number] },
  ];
  const sceneRnd = rng(o.seed * 31 + 7);
  let sceneHands: [number, number][][] = [];
  const at = (t: number, seed: number, keepHands = false) => {
    let idx = 0;
    while (idx < o.moves && t >= startTruth + idx * period + duration) idx++;
    const s = startTruth + idx * period;
    const turning = idx < o.moves && t >= s;
    const wob = o.wobble === false ? null : axisAngle([Math.sin(t / 700), 1, Math.cos(t / 900)].map((v, _, a) => v / Math.hypot(...a)) as Vec3, Math.sin(t / 400) * 0.06);
    const base = { width: w, height: h, orient: 0, eye, rotation: wob ?? undefined, offset: o.wobble === false ? undefined : ([0.12 * Math.sin(t / 500), 0.08 * Math.cos(t / 650), 0] as Vec3) };
    const sc = o.scene ? scene(base, t, o.scene, sceneRnd) : null;
    if (sc && keepHands) sceneHands = sc.hands;
    const occluders = o.hands === false || sc ? [] : occludersAt(t);
    return renderCube({
      ...base,
      state: states[idx],
      seed,
      gap: o.gap,
      turn: turning ? { move: truth[idx], fraction: ease(Math.min(1, (t - s) / duration)) } : undefined,
      occluders,
      realism: sc?.realism,
    });
  };

  const dt = 1000 / o.fps;
  let frames = 0;
  for (let t = 0; t <= total; t += dt) {
    const exp = o.exposureMs ?? 0;
    const img = exp > 0 ? averageImages([t - exp, t - exp / 2, t].map((ts, k) => at(Math.max(0, ts), frames * 3 + k, k === 2))) : at(t, frames, true);
    // 指（肌色の円）はアプリでは MediaPipe が手として隠す。同じように手のマスクとして渡す
    const hands = o.scene
      ? sceneHands
      : (o.hands === false ? [] : occludersAt(t)).map((oc) =>
          Array.from({ length: 12 }, (_, i) => [oc.center[0] + oc.radius * 1.15 * Math.cos((i * Math.PI) / 6), oc.center[1] + oc.radius * 1.15 * Math.sin((i * Math.PI) / 6)] as [number, number]),
        );
    o.onFrame?.(t, img, hands);
    if (frames % (o.every ?? 1) === 0) {
      const run = o.tracked ? processTracked : processFrame;
      const r = run(cv, img, t, { ...DEFAULT_PIPELINE, ...o.pipeline }, memory, engine.colors.refs, o.maskHands === false ? [] : hands);
      engine.push({ t, faces: r.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid, weight: f.weight, spread: f.spread, masked: f.masked, alts: f.alts })) });
    }
    refiner?.push(img, t, o.maskHands === false ? [] : hands);
    frames++;
  }
  const decoded = engine.decoder.bestMoves();
  const a = canonical(decoded.map((m) => m.move));
  const b = canonical(truth);
  let refined: SpeedResult["refined"];
  if (refiner) {
    const rr = refiner.result(o.solveTo ? solvedState() : states[states.length - 1]);
    refined = { ...rr, accuracy: 1 - editDistance(canonical(rr.moves.map((m) => m.move)), b) / Math.max(1, b.length) };
  }
  return {
    refined,
    refiner: refiner ?? undefined,
    accuracy: 1 - editDistance(a, b) / Math.max(1, b.length),
    final: statesEqual(engine.decoder.best().state, states[states.length - 1]),
    solved: isSolved(engine.decoder.best().state),
    truth,
    decoded,
    startTruth,
    endTruth,
    frames,
    engine,
  };
}
