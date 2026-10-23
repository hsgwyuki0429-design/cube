// メインスレッド ⇄ 認識 Worker のメッセージ
import type { EngineOptions, TrackUpdate } from "../track/engine";
import type { Lab } from "./color";
import type { Pt } from "./homography";
import type { DetectedFace, PipelineConfig } from "./pipeline";

export type ToWorker =
  | { type: "init" }
  | { type: "config"; config: Partial<PipelineConfig> }
  | { type: "frame"; id: number; t: number; bitmap: ImageBitmap }
  | { type: "hands"; hands: Pt[][] } // 正規化座標（0..1）
  | { type: "refs"; refs: Lab[] | null }
  | { type: "track-start"; state: number[]; refs: Lab[]; options: Partial<EngineOptions>; orients?: number[] }
  | { type: "track-options"; options: Partial<EngineOptions> }
  | { type: "track-reset"; state: number[]; orients?: number[] }
  | { type: "track-stop" };

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
}

export type FromWorker = { type: "ready"; ms: number; opencv: boolean } | { type: "error"; message: string } | FrameMessage;
