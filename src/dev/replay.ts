/**
 * リプレイ。保存 JSON を読み込み、カメラなしで追跡エンジンだけを再実行する。
 * 閾値やアルゴリズムを変えたときの効果を同一データで比較するのが目的。
 */

import { applySequence, solvedState, isSolved, stateSignature, type CubeState } from '../core/cube';
import { Tracker, defaultThresholds, type TrackerThresholds, type RoiObservation, type AppliedMove } from '../core/tracker';
import { classifyCells } from '../vision/color';
import type { RecordedSession } from './recorder';

export interface ReplayOptions {
  thresholds?: Partial<TrackerThresholds>;
  /**
   * 記録済みラベルを使わず、Lab から refLab で分類し直す。
   * 色分類側の変更を評価したいときに使う（既定 true。refLab が無ければ自動で false）。
   */
  reclassify?: boolean;
  /** reclassify 時に使う代表ベクトル。省略時は session.refLab */
  refLab?: ArrayLike<number>;
}

export interface ReplayResult {
  frames: number;
  moves: AppliedMove[];
  status: string;
  lostCount: number;
  transitionFrames: number;
  finalState: CubeState;
  solved: boolean;
  /** 実測処理時間（録画時のもの） */
  meanProcMs: number;
  meanFps: number;
  comparison: ReplayComparison | null;
  thresholds: TrackerThresholds;
}

export interface ReplayComparison {
  expected: string[];
  got: string[];
  /** 先頭から一致した手数 */
  matchedPrefix: number;
  /** 最初に食い違ったインデックス（-1 = 食い違いなし） */
  firstDivergence: number;
  /** 期待手順を最後まで正しく追えたか */
  complete: boolean;
  /** 期待より多く出た手（誤検出） */
  falsePositives: number;
  /** 取りこぼした手 */
  missed: number;
  /** 最終状態が期待状態と一致するか */
  finalStateMatches: boolean;
}

export function replaySession(session: RecordedSession, opts: ReplayOptions = {}): ReplayResult {
  const thresholds: TrackerThresholds = { ...defaultThresholds(), ...opts.thresholds };
  const initial = session.initialScramble
    ? applySequence(solvedState(), session.initialScramble)
    : solvedState();
  const tracker = new Tracker(initial, thresholds);

  const ref = opts.refLab ?? session.refLab;
  const reclassify = (opts.reclassify ?? true) && !!ref;

  const labBuf = new Float32Array(27);
  const labels = new Int8Array(9);
  const conf = new Float32Array(9);

  let procSum = 0;
  let fpsSum = 0;

  for (const f of session.frames) {
    const obs: RoiObservation[] = [];
    for (let k = 0; k < f.rois.length; k++) {
      const face = session.faces[k];
      if (face === undefined) continue;
      const r = f.rois[k];
      if (reclassify) {
        for (let i = 0; i < 9; i++) {
          labBuf[i * 3] = r.cells[i][0];
          labBuf[i * 3 + 1] = r.cells[i][1];
          labBuf[i * 3 + 2] = r.cells[i][2];
        }
        classifyCells(labBuf, ref!, labels, conf);
        obs.push({ face, labels: Int8Array.from(labels), conf: Float32Array.from(conf) });
      } else {
        obs.push({ face, labels: r.labels, conf: r.conf });
      }
    }
    tracker.step(obs, f.t);
    procSum += f.procMs;
    fpsSum += f.fps;
  }

  const got = tracker.moves.map((m) => m.notation);
  let comparison: ReplayComparison | null = null;
  if (session.expectedMoves) {
    const expected = session.expectedMoves;
    let matched = 0;
    while (matched < expected.length && matched < got.length && expected[matched] === got[matched]) matched++;
    const expectedState = applySequence(initial, expected.join(' '));
    comparison = {
      expected,
      got,
      matchedPrefix: matched,
      firstDivergence: matched === expected.length && matched === got.length ? -1 : matched,
      complete: matched === expected.length && got.length === expected.length,
      falsePositives: Math.max(0, got.length - expected.length),
      missed: Math.max(0, expected.length - got.length),
      finalStateMatches: stateSignature(tracker.state) === stateSignature(expectedState),
    };
  }

  const n = session.frames.length || 1;
  return {
    frames: session.frames.length,
    moves: tracker.moves.slice(),
    status: tracker.status,
    lostCount: tracker.lostCount,
    transitionFrames: tracker.transitionFrames,
    finalState: tracker.state,
    solved: isSolved(tracker.state),
    meanProcMs: procSum / n,
    meanFps: fpsSum / n,
    comparison,
    thresholds,
  };
}

/** 同一データに対して複数の閾値セットを比較する。チューニングの本体。 */
export function sweep(
  session: RecordedSession,
  variants: { name: string; thresholds: Partial<TrackerThresholds> }[],
  base: ReplayOptions = {},
): { name: string; result: ReplayResult }[] {
  return variants.map((v) => ({
    name: v.name,
    result: replaySession(session, { ...base, thresholds: { ...base.thresholds, ...v.thresholds } }),
  }));
}
