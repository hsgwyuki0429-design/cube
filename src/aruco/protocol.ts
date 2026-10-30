// ArUco 検証ページ ⇄ 解析 Worker のメッセージ
import type { StickerScheme } from "./codes";
import type { CubeFrame, CubeResult, VisibleFace } from "./cube";
import type { DetectorConfig } from "./detect";
import type { FrameRecord } from "./stats";

export interface AnalyzeOptions {
  configs: DetectorConfig[];
  maxSide: number; // 解析する画像の長辺（0 = 原寸）
  stride: number; // n フレームに 1 枚だけ解析する（1 = 全部）
  scheme: StickerScheme; // ステッカーの符号の種類
}

export interface VideoInfo {
  codec: string;
  width: number; // 表示の向き（回転後）、縮める前
  height: number;
  rotation: number;
  samples: number;
  fps: number; // ファイルの時刻での fps
  durationMs: number;
  analyzedWidth: number;
  analyzedHeight: number;
}

// キューブモード: 直前に解析したフレームの検出結果（方式 config）から面を組み立てて手順を推定する
export interface CubeRequest {
  config: number;
  endSolved: boolean;
  timeScale: number;
}

export type ToArucoWorker = { type: "init" } | { type: "analyze"; file: Blob; options: AnalyzeOptions } | { type: "cancel" } | ({ type: "cube" } & CubeRequest);

export type FromArucoWorker =
  | { type: "ready"; ms: number }
  | { type: "info"; info: VideoInfo }
  | { type: "frames"; items: FrameRecord[] }
  | { type: "progress"; done: number; total: number; elapsedMs: number }
  | { type: "done"; frames: number; cancelled: boolean }
  | { type: "cube"; faces: VisibleFace[][]; turns: CubeFrame["turn"][]; result: CubeResult }
  | { type: "error"; message: string };
