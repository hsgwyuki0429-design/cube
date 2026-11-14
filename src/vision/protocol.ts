// メインスレッド ⇄ 認識 Worker のメッセージ
import type { StickerScheme } from "../aruco/codes";
import type { Marker } from "../aruco/detect";
import type { DetectHint } from "./arucoFrame";
import type { EngineOptions, TrackUpdate } from "../track/engine";
import type { DecodedMove } from "../track/types";
import type { Lab } from "./color";
import type { Pt } from "./homography";
import type { DetectedFace, PipelineConfig } from "./pipeline";
import type { Recording } from "./recorder";
import type { RefineInput, RefineResult } from "./refine";
import type { VideoFileInfo } from "./videoFile";

export type ToWorker =
  | { type: "init"; opencv?: boolean } // opencv: false なら OpenCV を読み込まない（専用の検出だけを使う。本体のステッカー）
  | { type: "config"; config: Partial<PipelineConfig> }
  // seq: 送った順の通し番号（認識を Worker 2 つで交互に処理するとき、追跡はこの順に入れる）
  | { type: "frame"; id: number; t: number; bitmap: ImageBitmap; seq?: number }
  // 補助の Worker: 認識だけして結果を返す（追跡はしない）
  | { type: "recognize"; id: number; t: number; bitmap: ImageBitmap; seq: number }
  // 主の Worker へ: 補助の Worker の認識結果（seq の順に追跡に入れる）・補助が処理しなかったフレーム
  | { type: "foreign"; id: number; seq: number; t: number; width: number; height: number; result: RecognizedFrame; procMs: number }
  | { type: "foreign-skip"; seq: number }
  | { type: "track-start"; state: number[]; refs: Lab[]; options: Partial<EngineOptions>; orients?: number[] }
  | { type: "track-options"; options: Partial<EngineOptions> }
  | { type: "track-reset"; state: number[]; orients?: number[] }
  | { type: "track-stop" }
  | { type: "track-query"; id: number }
  | { type: "live-log"; id: number }
  | { type: "refine"; id: number; recording: Recording; input: RefineInput }
  // 追跡を精密解析の結果に乗り換える（t までを解き直した状態・姿勢・手順。keep はそれより前からあった手の数）
  // ソルブ中から進める精密解析: 録画の増えた分を少しずつ渡し、最後に終わりの時刻と状態を渡して結果をもらう
  // inspection: インスペクションから始める解析（タイマー）。stream-solving が届くまでのフレームは間引く
  | { type: "stream-feed"; id: number; input?: RefineInput; recording: Recording; inspection?: boolean }
  // 回し始めた（リアルタイムの開始の判定）: 時刻 from から後のフレームは全部処理する
  | { type: "stream-solving"; id: number; from: number }
  | { type: "stream-end"; id: number; to: number; target: number[] | null }
  | { type: "stream-cancel"; id: number }
  // フリーで完成した（時刻 t に状態 target）: そこまでを前後から解き直す
  // 動画ファイル（スロー撮影など）を精密解析する。target: 最後の状態（タイマーなら完成。分からなければ null）
  | { type: "video-refine"; id: number; file: Blob; input: RefineInput; target: number[] | null; options: VideoRefineOptions }
  | { type: "video-cancel"; id: number }
  // 検出だけ（精密解析の並列化: src/vision/detectPool.ts）
  | { type: "detect"; id: number; img: { data: Uint8ClampedArray; width: number; height: number }; hint: DetectHint | null; scheme: StickerScheme; design: string; thorough: boolean; quad?: boolean | Partial<import("../aruco/quadDetect").QuadOptions> };

export interface VideoRefineOptions {
  maxSide: number; // 長辺をこれに縮める
  captureFps?: number; // 撮影した fps（スロー再生用に書き出された動画の時刻を実際の時間に直す）
  maxFps: number; // 解析するフレームの間隔の上限（実際の時間で）
}

// 補助の Worker の認識結果（FrameResult と同じ形）
export interface RecognizedFrame {
  faces: DetectedFace[];
  quads: Pt[][];
  turn?: import("../track/types").TurnSnapshot;
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
  foreign?: boolean; // 補助の Worker が認識したフレーム（主の Worker が追跡して送った）
}

export type FromWorker =
  | { type: "ready"; ms: number; opencv: boolean }
  | { type: "error"; message: string }
  | FrameMessage
  | { type: "track-snapshot"; id: number; track: TrackUpdate | null }
  | { type: "live-log"; id: number; log: unknown }
  | { type: "refine-progress"; id: number; done: number; total: number }
  | { type: "refine-phase"; id: number; phase: "flush" | "decode" | "timing" }
  | { type: "refine-result"; id: number; result: RefineResult }
  | { type: "refine-error"; id: number; message: string }
  | { type: "stream-partial"; id: number; partial: StreamPartial }
  | { type: "video-info"; id: number; info: VideoFileInfo; analyzedFrames: number }
  | { type: "detected"; id: number; markers: Marker[] }
  // 待っている間に、より動きの小さいフレームを選んだので処理しなかったフレーム（送った枚数を数え直すため）
  | { type: "frame-skipped"; id: number; seq?: number }
  // 補助の Worker の認識結果
  | { type: "recognized"; id: number; seq: number; t: number; width: number; height: number; result: RecognizedFrame; procMs: number };

// ソルブ中の精密解析の途中結果（前向きに t まで解いたもの）
export interface StreamPartial {
  t: number; // 解析が進んだ時刻（ms）
  state: number[];
  orient: number;
  moves: DecodedMove[];
  status: string;
  frames: number;
  behindMs: number; // 受け取った録画の最後からの遅れ
}
