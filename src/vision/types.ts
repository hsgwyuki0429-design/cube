/** メインスレッド ⇄ 認識 Worker の通信プロトコル。 */

/** ROI 1枚ぶんの生観測。分類前。 */
export interface RoiSample {
  /** 9セル × Lab(L,a,b) = 27 */
  lab: Float32Array;
  /** 9セル × sRGB(0..255) = 27。デバッグ表示用 */
  rgb: Float32Array;
}

export interface FrameSample {
  seq: number;
  /** セッション開始からの経過 ms */
  t: number;
  /** Worker 内の処理時間 ms */
  procMs: number;
  rois: RoiSample[];
}

export interface WorkerRoiConfig {
  /** サンプリング点（正規化画像座標） 9 * k*k * 2 */
  samples: Float32Array;
  samplesPerAxis: number;
}

export type WorkerRequest =
  | { type: 'config'; rois: WorkerRoiConfig[]; procWidth: number }
  | { type: 'frame'; seq: number; t: number; bitmap: ImageBitmap };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; frame: FrameSample }
  | { type: 'error'; message: string };
