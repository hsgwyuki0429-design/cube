/**
 * 合成録画データの生成。
 *
 * 実機録画が揃うまでの回帰テスト用。**実録画の代わりにはならない** ので、
 * 生成したセッションには synthetic: true を必ず立てる。
 * Go/No-Go の判定は実録画でやること。
 */

import {
  applyMove, applySequence, getFacelets, parseSequence, solvedState,
  type CubeState, type FaceIndex, type Rng,
} from '../core/cube';
import { rgbToLab } from '../vision/color';
import type { RecordedSession, RecordedFrame, RecordedRoi } from './recorder';
import { classifyCells } from '../vision/color';

/** 標準的な配色の Lab。U,R,F,D,L,B = 白,赤,緑,黄,橙,青 */
export function standardPalette(): Float32Array {
  const rgb: [number, number, number][] = [
    [250, 250, 250], [190, 35, 40], [30, 155, 70],
    [245, 215, 45], [240, 120, 30], [30, 70, 175],
  ];
  const out = new Float32Array(18);
  rgb.forEach((c, i) => out.set(rgbToLab(c[0], c[1], c[2]), i * 3));
  return out;
}

/** 手や影で隠れたセルの Lab。どの色にも近くないので信頼度が落ちる。 */
const OCCLUDED_LAB: [number, number, number] = [62, 12, 18];

export interface SynthOptions {
  name: string;
  /** 追跡させたい手順 */
  moves: string;
  /** 記録開始時点の内部状態（完成状態からの手順） */
  initialScramble?: string | null;
  faces: FaceIndex[];
  /** カメラ fps */
  fps: number;
  /** Turns Per Second */
  tps: number;
  /** 1手のうち回転途中（見え方が定まらない）に費やす割合 0..1 */
  blurFraction: number;
  /** Lab に乗せるガウスノイズの標準偏差 */
  labNoise: number;
  /** セルが遮蔽される確率 */
  occlusion: number;
  /** 前後に入れる静止フレーム数 */
  idleFrames?: number;
  palette?: Float32Array;
  rng: Rng;
  notes?: string;
}

function gauss(rng: Rng, sigma: number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
}

export function synthesizeSession(o: SynthOptions): RecordedSession {
  const palette = o.palette ?? standardPalette();
  const moves = parseSequence(o.moves);
  const initial = o.initialScramble ? applySequence(solvedState(), o.initialScramble) : solvedState();

  // 各手の適用後の状態を先に作る
  const states: CubeState[] = [initial];
  for (const m of moves) states.push(applyMove(states[states.length - 1], m));

  const frameDt = 1000 / o.fps;
  const moveDt = 1000 / o.tps;
  const idle = o.idleFrames ?? Math.ceil(o.fps * 0.4);
  const totalMs = moves.length * moveDt;
  const frames: RecordedFrame[] = [];

  const labBuf = new Float32Array(27);
  const labels = new Int8Array(9);
  const conf = new Float32Array(9);

  const emit = (t: number, before: CubeState, after: CubeState, blurring: boolean) => {
    const rois: RecordedRoi[] = o.faces.map((face) => {
      const fBefore = getFacelets(before, face);
      const fAfter = getFacelets(after, face);
      const cells: [number, number, number][] = [];
      for (let i = 0; i < 9; i++) {
        // 回転途中で見え方が変わるセルは、両色の中間 + 大きめのノイズ（モーションブラー）
        const changing = blurring && fBefore[i] !== fAfter[i];
        const occluded = o.occlusion > 0 && o.rng() < o.occlusion;
        let L: number, a: number, b: number;
        if (occluded) {
          [L, a, b] = OCCLUDED_LAB;
        } else if (changing) {
          const c0 = fBefore[i] * 3;
          const c1 = fAfter[i] * 3;
          const w = o.rng();
          L = palette[c0] * w + palette[c1] * (1 - w);
          a = palette[c0 + 1] * w + palette[c1 + 1] * (1 - w);
          b = palette[c0 + 2] * w + palette[c1 + 2] * (1 - w);
        } else {
          const c = fAfter[i] * 3;
          L = palette[c];
          a = palette[c + 1];
          b = palette[c + 2];
        }
        const sigma = changing ? o.labNoise * 3 : o.labNoise;
        L += gauss(o.rng, sigma);
        a += gauss(o.rng, sigma);
        b += gauss(o.rng, sigma);
        cells.push([+L.toFixed(2), +a.toFixed(2), +b.toFixed(2)]);
        labBuf[i * 3] = L;
        labBuf[i * 3 + 1] = a;
        labBuf[i * 3 + 2] = b;
      }
      classifyCells(labBuf, palette, labels, conf);
      return {
        cells,
        labels: Array.from(labels),
        conf: Array.from(conf).map((c) => +c.toFixed(3)),
      };
    });
    frames.push({ t: +t.toFixed(1), rois, fps: o.fps, procMs: 0 });
  };

  let t = 0;
  for (let i = 0; i < idle; i++, t += frameDt) emit(t, initial, initial, false);

  const t0 = t;
  while (t - t0 < totalMs) {
    const rel = t - t0;
    const idx = Math.min(moves.length - 1, Math.floor(rel / moveDt));
    const phase = (rel - idx * moveDt) / moveDt;
    const blurring = phase < o.blurFraction;
    emit(t, states[idx], states[idx + 1], blurring);
    t += frameDt;
  }
  const last = states[states.length - 1];
  for (let i = 0; i < idle; i++, t += frameDt) emit(t, last, last, false);

  return {
    version: 1,
    name: o.name,
    createdAt: Date.now(),
    faces: o.faces,
    initialScramble: o.initialScramble ?? null,
    expectedMoves: moves.map((m) => m.token),
    refLab: Array.from(palette),
    synthetic: true,
    notes: o.notes ??
      `合成データ: tps=${o.tps} fps=${o.fps} blur=${o.blurFraction} noise=${o.labNoise} occlusion=${o.occlusion}`,
    frames,
  };
}
