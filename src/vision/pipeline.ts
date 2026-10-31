// 1 フレームの処理: ArUco マーカー（各ステッカーに色付きのマーカー）を検出して見えている面を組み立て、各セルの色（代表色の Lab）・
// ステッカーの ID・読みの確からしさを返す（src/vision/arucoFrame.ts）。Worker とテストの両方から使う（OpenCV のオブジェクトは呼び出し側が渡す）
import { stickerScheme } from "../aruco/codes";
import type { FaceLayer } from "../aruco/cube";
import { processAruco } from "./arucoFrame";
import type { Lab } from "./color";
import type { Mat3, Pt } from "./homography";
import type { CV, PixelSource } from "./image";
import type { TurnSnapshot } from "../track/types";

export interface PipelineConfig {
  // ステッカーの符号の種類（src/aruco/codes.ts）。unique54: 3×3 の 54 種類（マスごとに違う）、aruco12: 3×3 の 12 種類、
  // aruco: 最初に印刷した 4×4 の 54 種類
  stickers: "unique54" | "aruco12" | "aruco";
  arucoThorough?: boolean; // 二値化の窓を細かく試す（精密解析。src/aruco/detect.ts の THOROUGH_PARAMS）
  // 組み立てた面の読めなかったマスを、切り出して拡大して読み直す数（再認識。src/aruco/reread.ts）。
  // 省略時はライブ 4・精密解析（arucoThorough）は全部
  arucoReread?: number;
  // 先に読み直すマス（カメラフレームの slot * 9 + cell）。追跡が未確定・推定とみているマス（TrackerEngine.cellBelief）
  focus?: number[];
  // それでも読めなかったマスを色で補う（既定 true。src/aruco/colorFill.ts）
  arucoColorFill?: boolean;
  // ID が読めなかったマスに、直前のフレームの同じマスのステッカーを引き継ぐ（既定 true。src/aruco/idTrack.ts）
  arucoIdTrack?: boolean;
  // 直前のフレームのマーカーの周りだけを切り出して検出する（本体のライブと精密解析。src/vision/arucoFrame.ts）
  arucoRegion?: boolean;
  // ステッカーの中のマーカーの配置（src/aruco/design.ts の key。standard = 今の 1 個、quad-half = 4 個・幅 1/2）
  arucoDesign?: string;
  // 回転途中の形状認識で回している層と角度を求め、追跡の手がかりにする（既定 true。src/aruco/turn.ts）
  arucoTurn?: boolean;
  // マーカーが大きく映っていたら、切り出しを半分に縮めて検出する（既定 true。src/vision/arucoFrame.ts）
  arucoShrink?: boolean;
}

export const DEFAULT_PIPELINE: PipelineConfig = { stickers: "unique54" };

export interface DetectedFace {
  slot: number; // カメラフレームの面（0 上 / 1 右 / 2 正面 / 3 下 / 4 左）
  rot: number; // 格子の回転（組み立てた面は常に 0）
  held?: boolean; // 1 列・1 枚の面（外枠は推定。3D の傾きの計算には使わない）
  H: Mat3; // 面の座標（x = 列・y = 行、0〜3）→ 画像
  found: number; // 色の分かったマス
  labs: Lab[];
  spread: number[];
  valid: boolean[];
  weight: number[]; // セルの読みの確からしさ
  masked: boolean[];
  ids?: number[]; // 読んだステッカーの ID（揃った状態での facelet 番号。-1 = 不明。54 種類の符号のとき）
  layer?: FaceLayer; // 回している途中の層（外側の 1 列）の格子。H は残りの 2 列（本体）の格子
}

export interface FrameResult {
  faces: DetectedFace[];
  quads: Pt[][]; // 検出したマーカーの四隅（デバッグ表示用）
  turn?: TurnSnapshot; // 回転途中の形で見えた層の回転（前のフレームからのつながり）
}

// memory: フレームの間で引き継ぐもの（キューブの傾き・ID なし追跡・直前のマーカーの範囲）の入れ物。同じ映像には同じものを渡す
export function processFrame(cv: CV, img: PixelSource, t: number, config: PipelineConfig, memory: object): FrameResult {
  return processAruco(cv, img, t, memory, stickerScheme(config.stickers), !!config.arucoThorough, {
    reread: config.arucoReread,
    focus: config.focus,
    colorFill: config.arucoColorFill,
    idTrack: config.arucoIdTrack,
    region: config.arucoRegion,
    design: config.arucoDesign,
    turn: config.arucoTurn,
    shrink: config.arucoShrink,
  });
}
