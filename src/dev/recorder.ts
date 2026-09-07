/**
 * 録画基盤。改善を定量評価するための土台であって、おまけではない。
 *
 * 記録するのは Lab 値が本体。生映像がなくても、閾値やアルゴリズムを変えたときの
 * 効果を同一データで比較できることが目的（CLAUDE.md「録画・リプレイ基盤」）。
 */

import type { FaceIndex } from '../core/cube';
import type { FrameSample } from '../vision/types';
import type { CubeTrackingState, TrackingConfig } from '../tracking/types';

/**
 * 録画フォーマットのバージョン。
 * v1: Phase 0（Lab / labels / conf / fps / procMs）
 * v2: Phase 0.5 で姿勢追跡の情報を追加。v1 の録画もそのまま読める。
 */
export const SESSION_VERSION = 2;
export const SUPPORTED_VERSIONS = [1, 2];

export interface RecordedRoi {
  /** 9セル × Lab */
  cells: [number, number, number][];
  /** 分類ラベル 0..5（-1 = 未分類） */
  labels: number[];
  conf: number[];
  /** v2: 追跡がこの ROI を信用しているか。false なら色を読んでいない */
  trusted?: boolean;
}

/** v2: フレームごとの姿勢追跡の記録。 */
export interface RecordedTracking {
  status: string;
  confidence: number;
  gridLock: number;
  reprojectionError: number;
  trackedPoints: number;
  totalPoints: number;
  faces: {
    id: string;
    /** 四隅（正規化画像座標） */
    corners: [number, number][];
    visible: boolean;
    gridLock: number;
    inliers: number;
    reprojectionError: number;
  }[];
}

export interface RecordedFrame {
  /** 記録開始からの経過 ms */
  t: number;
  rois: RecordedRoi[];
  /** そのフレーム時点の処理fps */
  fps: number;
  /** Worker の処理時間 ms */
  procMs: number;
  /** v2: 姿勢追跡の状態。手動 ROI モードでは無い */
  tracking?: RecordedTracking;
  /** v2: 内訳（ms） */
  trackMs?: number;
  samplingMs?: number;
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
  /** v2: ROI 座標の供給元 */
  roiMode?: 'manual' | 'tracked';
  /** v2: 追跡の設定。後から「追跡ミスか色ミスか」を切り分けるのに要る */
  trackingConfig?: TrackingConfig;
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
      const out: RecordedRoi = {
        cells,
        labels: Array.from(labels[k] ?? new Int8Array(9).fill(-1)),
        conf: Array.from(conf[k] ?? new Float32Array(9)).map((c) => round(c, 3)),
      };
      if (r.trusted !== undefined) out.trusted = r.trusted;
      return out;
    });
    const rec: RecordedFrame = {
      t: round(frame.t, 1), rois, fps: round(fps, 1), procMs: round(frame.procMs, 2),
    };
    if (frame.tracking) rec.tracking = compactTracking(frame.tracking);
    if (frame.timing) {
      rec.trackMs = round(frame.timing.trackingMs, 2);
      rec.samplingMs = round(frame.timing.samplingMs, 2);
    }
    this.session.frames.push(rec);
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

/**
 * 追跡状態を録画用に圧縮する。
 * 後から「色分類ミス / ROI追跡ミス / Move Trackerミス」を切り分けるのに使う。
 */
function compactTracking(t: CubeTrackingState): RecordedTracking {
  return {
    status: t.status,
    confidence: round(t.confidence, 3),
    gridLock: round(t.gridSupport, 3),
    reprojectionError: round(t.reprojectionError, 2),
    trackedPoints: t.trackedPoints,
    totalPoints: t.totalPoints,
    faces: t.faces.map((f) => ({
      id: f.id,
      corners: f.corners.map((p) => [round(p.x, 2), round(p.y, 2)] as [number, number]),
      visible: f.visible,
      gridLock: round(f.gridLock, 3),
      inliers: f.inliers,
      reprojectionError: round(f.reprojectionError, 2),
    })),
  };
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
  if (!SUPPORTED_VERSIONS.includes(s.version)) throw new Error(`未対応の version: ${s.version}`);
  if (!Array.isArray(s.faces)) throw new Error('faces がありません');
  return s;
}
