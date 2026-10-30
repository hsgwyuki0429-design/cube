// メインスレッド ⇄ 認識 Worker のメッセージ
import type { EngineOptions, TrackUpdate } from "../track/engine";
import type { DecodedMove } from "../track/types";
import type { Lab } from "./color";
import type { Pt } from "./homography";
import type { DetectedFace, PipelineConfig } from "./pipeline";
import type { Recording } from "./recorder";
import type { RefineInput, RefineResult } from "./refine";
import type { VideoFileInfo } from "./videoFile";

export type ToWorker =
  | { type: "init" }
  | { type: "config"; config: Partial<PipelineConfig> }
  | { type: "frame"; id: number; t: number; bitmap: ImageBitmap }
  | { type: "track-start"; state: number[]; refs: Lab[]; options: Partial<EngineOptions>; orients?: number[] }
  | { type: "track-options"; options: Partial<EngineOptions> }
  | { type: "track-reset"; state: number[]; orients?: number[] }
  | { type: "track-stop" }
  | { type: "track-query"; id: number }
  | { type: "refine"; id: number; recording: Recording; input: RefineInput }
  // 追跡を精密解析の結果に乗り換える（t までを解き直した状態・姿勢・手順。keep はそれより前からあった手の数）
  | { type: "track-rebase"; state: number[]; orient: number; moves: DecodedMove[]; t: number; keep: number }
  // ソルブ中から進める精密解析: 録画の増えた分を少しずつ渡し、最後に終わりの時刻と状態を渡して結果をもらう
  | { type: "stream-feed"; id: number; input?: RefineInput; recording: Recording }
  | { type: "stream-end"; id: number; to: number; target: number[] | null }
  | { type: "stream-cancel"; id: number }
  // フリーで完成した（時刻 t に状態 target）: そこまでを前後から解き直す
  | { type: "stream-anchor"; id: number; t: number; target: number[] }
  // 動画ファイル（スロー撮影など）を精密解析する。target: 最後の状態（タイマーなら完成。分からなければ null）
  | { type: "video-refine"; id: number; file: Blob; input: RefineInput; target: number[] | null; options: VideoRefineOptions }
  | { type: "video-cancel"; id: number };

export interface VideoRefineOptions {
  maxSide: number; // 長辺をこれに縮める
  captureFps?: number; // 撮影した fps（スロー再生用に書き出された動画の時刻を実際の時間に直す）
  maxFps: number; // 解析するフレームの間隔の上限（実際の時間で）
}

export interface FrameMessage {
  type: "frame";
  id: number;
  t: number;
  width: number;
  height: number;
  faces: DetectedFace[];
  quads: Pt[][];
  procMs: number;
  track?: TrackUpdate;
  looksSolved?: boolean; // 見えている面がすべて1色（追跡を見失っていても完成を検出できるように）
  // キューブの連続的な姿勢: R = カメラフレームに揃ったキューブ → 実際、orient = このフレームの離散的な姿勢。
  // キューブ固定フレーム → カメラの回転は R · ORIENTATIONS[orient]
  pose?: { R: number[]; err: number; orient: number };
}

export type FromWorker =
  | { type: "ready"; ms: number; opencv: boolean }
  | { type: "error"; message: string }
  | FrameMessage
  | { type: "track-snapshot"; id: number; track: TrackUpdate | null }
  | { type: "refine-progress"; id: number; done: number; total: number }
  | { type: "refine-result"; id: number; result: RefineResult }
  | { type: "refine-error"; id: number; message: string }
  | { type: "stream-partial"; id: number; partial: StreamPartial }
  | { type: "video-info"; id: number; info: VideoFileInfo; analyzedFrames: number };

// ソルブ中の精密解析の途中結果（前向きに t まで解いたもの）
export interface StreamPartial {
  t: number; // 解析が進んだ時刻（ms）
  state: number[];
  orient: number;
  moves: DecodedMove[];
  status: string;
  frames: number;
  behindMs: number; // 受け取った録画の最後からの遅れ
  anchored?: boolean; // 完成の区切りまでを前後から解き直した結果
}
