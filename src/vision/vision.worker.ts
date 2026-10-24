// 認識 Worker: OpenCV.js（約13MB）の読み込み、1フレームの処理、追跡エンジンの実行。
// メインスレッドは描画と UI だけを受け持つ。
import cvModule from "@techstark/opencv-js";
import { TrackerEngine } from "../track/engine";
import { decodeRecording } from "./decode";
import { estimatePose } from "./pose";
import { processTracked } from "./roi";
import { Refiner } from "./refine";
import type { Lab } from "./color";
import type { Pt } from "./homography";
import { DEFAULT_PIPELINE, type PipelineConfig, type PipelineMemory } from "./pipeline";
import type { FrameMessage, FromWorker, ToWorker } from "./protocol";
import { type CV, initOpenCv } from "./quads";

let cv: CV | null = null;
let config: PipelineConfig = { ...DEFAULT_PIPELINE };
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let hands: Pt[][] = [];
let refs: Lab[] | null = null;
let engine: TrackerEngine | null = null;
const memory: { last: PipelineMemory | null } = { last: null };

const post = (msg: FromWorker) => (self as unknown as Worker).postMessage(msg);

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "init": {
        const t0 = performance.now();
        try {
          cv = await initOpenCv(cvModule);
        } catch (e) {
          cv = null;
          console.warn("OpenCV.js を読み込めませんでした。ガイド枠モードで動きます。", e);
        }
        post({ type: "ready", ms: performance.now() - t0, opencv: !!cv });
        return;
      }
      case "config":
        config = { ...config, ...msg.config, quads: { ...config.quads, ...(msg.config.quads ?? {}) } };
        return;
      case "hands":
        hands = msg.hands;
        return;
      case "refs":
        refs = msg.refs;
        return;
      case "track-start":
        refs = msg.refs;
        engine = new TrackerEngine(Uint8Array.from(msg.state), msg.refs, msg.options, msg.orients);
        return;
      case "track-options":
        engine?.setOptions(msg.options);
        return;
      case "track-reset":
        engine?.reset(Uint8Array.from(msg.state), msg.orients);
        return;
      case "track-stop":
        engine = null;
        return;
      case "track-query":
        post({ type: "track-snapshot", id: msg.id, track: engine ? engine.snapshot() : null });
        return;
      case "refine": {
        // ソルブ後の精密解析（タイマー用の別の Worker で動かす。リアルタイムの追跡は止めない）
        const { recording, input, id } = msg;
        try {
          const refiner = new Refiner(cv, { ...input, pipeline: { ...config, ...input.pipeline } });
          const total = recording.chunks.filter((c) => c.timestamp / 1000 >= input.from && c.timestamp / 1000 <= input.to).length;
          let done = 0;
          let lastPost = 0;
          await decodeRecording(recording, (img, t) => {
            if (t < input.from || t > input.to) return;
            refiner.push(img, t);
            done++;
            if (performance.now() - lastPost > 200) {
              lastPost = performance.now();
              post({ type: "refine-progress", id, done, total });
            }
          });
          post({ type: "refine-result", id, result: refiner.result() });
        } catch (e) {
          post({ type: "refine-error", id, message: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      case "frame": {
        const t0 = performance.now();
        const { bitmap } = msg;
        const w = bitmap.width;
        const h = bitmap.height;
        if (!ctx || ctx.canvas.width !== w || ctx.canvas.height !== h) ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
        ctx!.drawImage(bitmap, 0, 0);
        bitmap.close();
        const img = ctx!.getImageData(0, 0, w, h);
        const handsPx = hands.map((hull) => hull.map(([x, y]) => [x * w, y * h] as Pt));
        // キューブを見つけた後は、直前の位置の周りだけを縮小して処理する（速さが追従の前提）
        const result = processTracked(cv, img, msg.t, config, memory, engine ? engine.colors.refs : refs, handsPx);
        const reading = { t: msg.t, faces: result.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid, weight: f.weight, spread: f.spread, masked: f.masked })) };
        const track = engine?.push(reading) ?? undefined;
        let looksSolved: boolean | undefined;
        let pose: FrameMessage["pose"];
        if (engine && reading.faces.length) {
          const labels = engine.labelsOf(reading);
          looksSolved = engine.looksSolved(reading, labels);
          const p = estimatePose(result.faces, w, h);
          if (p && p.err < Math.max(4, w / 100)) pose = { R: p.R, err: p.err, orient: engine.frameOrient(reading, labels) };
        }
        post({ type: "frame", id: msg.id, t: msg.t, width: w, height: h, faces: result.faces, quads: result.quads, procMs: performance.now() - t0, track, looksSolved, pose });
        return;
      }
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
