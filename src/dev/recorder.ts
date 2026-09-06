/**
 * 録画基盤。改善を定量評価するための土台であって、おまけではない。
 *
 * 記録するのは Lab 値が本体。生映像がなくても、閾値やアルゴリズムを変えたときの
 * 効果を同一データで比較できることが目的（CLAUDE.md「録画・リプレイ基盤」）。
 */

import type { FaceIndex } from '../core/cube';
import type { FrameSample } from '../vision/types';

export const SESSION_VERSION = 1;

export interface RecordedRoi {
  /** 9セル × Lab */
  cells: [number, number, number][];
  /** 分類ラベル 0..5（-1 = 未分類） */
  labels: number[];
  conf: number[];
}

export interface RecordedFrame {
  /** 記録開始からの経過 ms */
  t: number;
  rois: RecordedRoi[];
  /** そのフレーム時点の処理fps */
  fps: number;
  /** Worker の処理時間 ms */
  procMs: number;
}

export interface RecordedSession {
  version: number;
  name: string;
  createdAt: number;
  /** frame.rois の並びに対応する空間面 */
  faces: FaceIndex[];
  /** 記録開始時の内部状態（完成状態からの手順）。null なら完成状態 */
  initialScramble: string | null;
  /** 正解手順。回帰テストで比較する。分からない録画では省略 */
  expectedMoves?: string[];
  /** リプレイ時に Lab から再分類するための代表ベクトル（18要素） */
  refLab?: number[];
  camera?: {
    width: number;
    height: number;
    requestedFps: number;
    negotiatedFps: number | null;
    measuredFps: number;
    label: string;
  };
  /** 合成データか実録画か。混同すると Go/No-Go を誤る */
  synthetic?: boolean;
  notes?: string;
  frames: RecordedFrame[];
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export class Recorder {
  session: RecordedSession | null = null;
  recording = false;

  start(meta: Omit<RecordedSession, 'version' | 'createdAt' | 'frames'>): void {
    this.session = { version: SESSION_VERSION, createdAt: Date.now(), frames: [], ...meta };
    this.recording = true;
  }

  /**
   * 1フレーム記録する。認識を間引いても記録は間引かない方針なので、
   * 呼び出し側は結果が来たフレームを全て渡すこと。
   */
  add(frame: FrameSample, labels: ArrayLike<number>[], conf: ArrayLike<number>[], fps: number): void {
    if (!this.recording || !this.session) return;
    const rois: RecordedRoi[] = frame.rois.map((r, k) => {
      const cells: [number, number, number][] = [];
      for (let i = 0; i < 9; i++) {
        cells.push([round(r.lab[i * 3]), round(r.lab[i * 3 + 1]), round(r.lab[i * 3 + 2])]);
      }
      return {
        cells,
        labels: Array.from(labels[k] ?? new Int8Array(9).fill(-1)),
        conf: Array.from(conf[k] ?? new Float32Array(9)).map((c) => round(c, 3)),
      };
    });
    this.session.frames.push({ t: round(frame.t, 1), rois, fps: round(fps, 1), procMs: round(frame.procMs, 2) });
  }

  stop(): RecordedSession | null {
    this.recording = false;
    return this.session;
  }

  get frameCount(): number {
    return this.session?.frames.length ?? 0;
  }

  /** 概算サイズ（MB）。長時間録画で膨らむので画面に出す。 */
  get approxSizeMb(): number {
    return (this.frameCount * (this.session?.faces.length ?? 1) * 9 * 26) / 1e6;
  }

  toJson(): string {
    return JSON.stringify(this.session);
  }
}

export function downloadSession(session: RecordedSession, filename?: string): void {
  const blob = new Blob([JSON.stringify(session)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? `${session.name.replace(/\s+/g, '_')}_${session.createdAt}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseSession(text: string): RecordedSession {
  const s = JSON.parse(text) as RecordedSession;
  if (typeof s !== 'object' || !Array.isArray(s.frames)) throw new Error('録画JSONの形式が不正です');
  if (s.version !== SESSION_VERSION) throw new Error(`未対応の version: ${s.version}`);
  if (!Array.isArray(s.faces)) throw new Error('faces がありません');
  return s;
}
