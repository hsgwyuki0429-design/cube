// メインスレッド ⇄ 認識 Worker のメッセージ
import type { EngineOptions, TrackUpdate } from "../track/engine";
import type { Lab } from "./color";
import type { Pt } from "./homography";
import type { DetectedFace, PipelineConfig } from "./pipeline";
import type { Recording } from "./recorder";
import type { RefineInput, RefineResult } from "./refine";

export type ToWorker =
  | { type: "init" }
  | { type: "config"; config: Partial<PipelineConfig> }
  | { type: "frame"; id: number; t: number; bitmap: ImageBitmap }
  | { type: "hands"; hands: Pt[][] } // 正規化座標（0..1）
  | { type: "refs"; refs: Lab[] | null }
  | { type: "track-start"; state: number[]; refs: Lab[]; options: Partial<EngineOptions>; orients?: number[] }
  | { type: "track-options"; options: Partial<EngineOptions> }
  | { type: "track-reset"; state: number[]; orients?: number[] }
  | { type: "track-stop" }
  | { type: "track-query"; id: number }
  | { type: "refine"; id: number; recording: Recording; input: RefineInput };

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
  | { type: "refine-error"; id: number; message: string };
