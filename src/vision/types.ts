/** メインスレッド ⇄ 認識 Worker の通信プロトコル。 */

import type { CubeTrackingState, InitHint, TrackingConfig, VisibleFaceId } from '../tracking/types';

/** ROI 1枚ぶんの生観測。分類前。 */
export interface RoiSample {
  /** 9セル × Lab(L,a,b) = 27 */
  lab: Float32Array;
  /** 9セル × sRGB(0..255) = 27。デバッグ表示用 */
  rgb: Float32Array;
  /**
   * この ROI の色を信用してよいか。
   * 追跡モードで面を見失っているときは false になり、下流は色を使わない。
   * 手動モードでは常に true（後方互換）。
   */
  trusted?: boolean;
}

export interface FrameTiming {
  /** ピクセルのサンプリング + Lab 変換 */
  samplingMs: number;
  /** 姿勢追跡（オプティカルフロー + ホモグラフィ） */
  trackingMs: number;
  flowMs: number;
  homographyMs: number;
}

export interface FrameSample {
  seq: number;
  /** セッション開始からの経過 ms */
  t: number;
  /** Worker 内の処理時間 ms */
  procMs: number;
  rois: RoiSample[];
  /** 追跡モードのときだけ入る */
  tracking?: CubeTrackingState;
  timing?: FrameTiming;
}

export interface WorkerRoiConfig {
  /** サンプリング点（正規化画像座標） 9 * k*k * 2 */
  samples: Float32Array;
  samplesPerAxis: number;
}

/** 追跡モードで、追跡された面をどの ROI として使うか。 */
export interface TrackedRoiConfig {
  /** 幾何的な可視面（上 / 前 / 右）。空間面への割り当ては face で行う */
  faceId: VisibleFaceId;
  rotate: 0 | 1 | 2 | 3;
  mirror: boolean;
  enabled: boolean;
}

export type WorkerRequest =
  | { type: 'config'; rois: WorkerRoiConfig[]; procWidth: number }
  | {
      type: 'trackingConfig';
      enabled: boolean;
      rois: TrackedRoiConfig[];
      samplesPerAxis: number;
      config: TrackingConfig;
      /** デバッグ用の特徴点を返すか */
      collectPoints: boolean;
    }
  /** 次のフレームで追跡を初期化する。座標は正規化画像座標で渡す */
  | { type: 'initTracking'; hint: InitHint }
  | { type: 'resetTracking' }
  | { type: 'frame'; seq: number; t: number; bitmap: ImageBitmap };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; frame: FrameSample }
  | { type: 'trackingInit'; ok: boolean; reason: string | null }
  | { type: 'error'; message: string };
