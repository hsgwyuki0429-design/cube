/** キューブ姿勢追跡の型。UI・Worker・録画で共有する。 */

import type { Point2D, Quad } from './geometry';
import type { VisibleFaceId } from './hexModel';

export type { VisibleFaceId };

export type TrackingStatus =
  | 'UNINITIALIZED'
  | 'INITIALIZING'
  | 'TRACKING'
  | 'DEGRADED'
  | 'LOST';

export interface TrackedFace {
  id: VisibleFaceId;
  corners: Quad;
  confidence: number;
  visible: boolean;
  /** RANSAC のインライア数 / 特徴点総数 */
  inliers: number;
  totalPoints: number;
  /** 平均再投影誤差（px） */
  reprojectionError: number;
  /** 直近フレームで自前の観測から更新できたか（false = 他面から推定した） */
  measured: boolean;
  /** この面のグリッドロック比 */
  gridLock: number;
}

export interface TrackedPointDebug {
  x: number;
  y: number;
  /** 前フレーム位置。オプティカルフローのベクトル表示用 */
  px: number;
  py: number;
  ok: boolean;
  inlier: boolean;
  face: VisibleFaceId;
}

export interface CubeTrackingState {
  status: TrackingStatus;
  faces: TrackedFace[];
  confidence: number;
  /** 最後に TRACKING だった時刻（ms） */
  lastGoodTimestamp: number;
  /** 全体の平均再投影誤差（px） */
  reprojectionError: number;
  trackedPoints: number;
  totalPoints: number;
  /** DEGRADED が続いているフレーム数 */
  degradedFrames: number;
  /** LOST になった理由。UI に出す */
  reason: string | null;
  /** グリッドロック比。1 付近だとキューブのグリッドに乗っていない */
  gridSupport: number;
  /** デバッグ描画用。無効化できる */
  points: TrackedPointDebug[];
}

export interface TrackingConfig {
  /** RANSAC のインライア判定（px） */
  ransacThreshold: number;
  ransacIterations: number;
  /** 面ごとに必要な最小インライア数 */
  minInliersPerFace: number;
  /**
   * インライアが面内で覆うべき最小面積（正規化面座標の外接矩形、0..1）。
   * 点数が足りていても片側に偏っていると四隅が外挿になって破綻するため、
   * 広がりも条件にする。手で面の半分が隠れたときに効く。
   */
  minInlierSpread: number;
  /**
   * 見失っていた面が戻るとき、観測が予測からどれだけ離れてよいか（面の一辺に対する比）。
   * グリッドは1セル周期なので、ずれた位置にも自己整合的に貼り付いてしまう。
   * 1セル = 1/3 なので、それより小さくする。
   */
  maxReentryJumpRatio: number;
  /**
   * 3つの可視面の面積比の上限。立方体を角から見ると3面の面積は同程度になるので、
   * 片方が極端に膨らんだらモデルが破綻している。
   * 個々の四角形の検証だけでは、毎フレーム少しずつ膨らむ破綻を止められない。
   */
  maxFaceAreaRatio: number;
  /** 予測で置いた面をグリッドに吸着させる */
  snapPredictedFaces: boolean;
  /** 吸着の最大移動量（正規化面座標）。1セル = 1/3 なので半セル未満に保つ */
  maxSnapShift: number;
  /** confidence がこれ未満なら DEGRADED */
  degradedConfidence: number;
  /** DEGRADED がこのフレーム数続いたら LOST（60fps で 45 = 0.75秒） */
  lostAfterDegradedFrames: number;
  /** DEGRADED から TRACKING に戻るのに必要な連続良好フレーム数 */
  recoverFrames: number;
  /**
   * 全ての面を見失った状態がこのフレーム数を超えたら即 LOST にする。
   * 全面遮蔽の後に盲目的に再ロックすると、1セルずれた位置へ貼り付いたまま
   * 高い信頼度を出し続けてしまうため（実測で確認）。誤追跡より LOST を選ぶ。
   */
  blindFramesBeforeLost: number;
  /** 初期化後、TRACKING と認めるまでの確認フレーム数 */
  initializingFrames: number;
  /** 四角形の EMA 係数。1 で平滑化なし（追従優先） */
  smoothing: number;
  /** 面の共有頂点を一致させる */
  enforceSharedEdges: boolean;
  /** セルサンプリングの内側マージン。0.5 でセルの中央50% */
  cellSampleInset: number;
  /** DEGRADED のときエッジ吸着による局所再検出を試す */
  localRedetect: boolean;
  /** 追跡できなかった面を他面から推定して引きずる */
  predictFailedFaces: boolean;
  /**
   * 特徴点を面の境界からどれだけ内側に寄せるか（正規化面座標）。
   * 0 にすると点が面の縁に乗り、LK の窓へ背景や隣接面（別平面）が混入して
   * 系統的なドリフトになる。実測で 0 のとき translate の平均セル誤差が
   * 39px、0.05 で 5px 以下まで下がる。
   */
  featureInset: number;
  /** グリッドロック比を信頼度に掛ける（別物体への貼り付きを防ぐ） */
  useGridSupport: boolean;
  /**
   * ロック比がこれ以下なら信頼度 0。
   * 合成データでの実測: 正常追跡 1.84〜2.24 / 部分遮蔽でずれた面 1.3〜1.6 /
   * 遮蔽・キューブ消失 0.0〜1.0。1.5 に置くとどのシナリオでも誤追跡 0% になる。
   * 実キューブのステッカー間隔やコントラストで変わるので実行時に調整できるようにしてある。
   */
  minGridLock: number;
  /** ロック比がこれ以上なら減点なし */
  fullGridLock: number;
}

export function defaultTrackingConfig(): TrackingConfig {
  return {
    ransacThreshold: 2.5,
    ransacIterations: 32,
    minInliersPerFace: 6,
    minInlierSpread: 0.28,
    maxReentryJumpRatio: 0.22,
    maxFaceAreaRatio: 6,
    snapPredictedFaces: true,
    maxSnapShift: 0.12,
    degradedConfidence: 0.55,
    lostAfterDegradedFrames: 45,
    recoverFrames: 3,
    blindFramesBeforeLost: 8,
    initializingFrames: 2,
    smoothing: 1,
    enforceSharedEdges: true,
    cellSampleInset: 0.5,
    localRedetect: true,
    predictFailedFaces: true,
    featureInset: 0.07,
    useGridSupport: true,
    minGridLock: 1.5,
    fullGridLock: 1.8,
  };
}

export interface InitHint {
  kind: 'tap' | 'box' | 'corners' | 'quads';
  /** kind='tap' */
  point?: Point2D;
  radius?: number;
  /** kind='box' 画像座標の矩形 */
  box?: { x: number; y: number; w: number; h: number };
  /** kind='corners' 手前の角と3方向の隣接頂点 */
  corners?: [Point2D, Point2D, Point2D, Point2D];
  /** kind='quads' 既存の手動 ROI から。U/F/R の順 */
  quads?: Quad[];
}
