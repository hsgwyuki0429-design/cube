// 認識 Worker: OpenCV.js（約13MB）の読み込み、1フレームの処理、追跡エンジンの実行。
// メインスレッドは描画と UI だけを受け持つ。
import { type Mat3, ORIENTATIONS, mul } from "../cube/model";
import { TrackerEngine, focusCells } from "../track/engine";
import { StreamDecoder, decodeRecording } from "./decode";
import { StillSkipper } from "./motion";
import { estimatePose, rotationAngle } from "./pose";
import { Refiner } from "./refine";
import { DetectPool, ParallelFeeder, poolSize } from "./detectPool";
import { stickerScheme } from "../aruco/codes";
import { detectWithHint, detectorFor } from "./arucoFrame";
import { DEFAULT_PIPELINE, type PipelineConfig, frameReading, processFrame } from "./pipeline";
import type { FrameMessage, FromWorker, StreamPartial, ToWorker } from "./protocol";
import type { CV } from "./image";
import { loadOpenCv } from "./opencv";

let cv: CV | null = null;
let config: PipelineConfig = { ...DEFAULT_PIPELINE };
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let engine: TrackerEngine | null = null;
const memory = {}; // フレームの間で引き継ぐもの（processFrame）
let lastPose: { t: number; M: Mat3 } | null = null; // 直前に送った 3D の向き（キューブ固定 → カメラ）
let focus: number[] | undefined; // 追跡が未確定・推定とみているマス（ArUco で先に読み直す）

// ソルブ中から進める精密解析（解析用の Worker で使う）
interface Stream {
  refiner: Refiner;
  decoder: StreamDecoder | null;
  fedUntil: number; // 受け取った録画の最後の時刻（ms）
  lastPartial: number;
  still: StillSkipper;
  anchor?: { t: number; target: Uint8Array };
  end?: { from: number; to: number; posted: number }; // 止めた後: 残りの解析の進み具合を知らせる
  // 検出を別の Worker に分ける。OpenCV の読み込みに時間がかかるので、解析を始めたときに起こしておく。コアが少ない端末では
  // ソルブ中はライブの認識と CPU を取り合うので使わず、止めた後（ライブが要らなくなった後）の残りだけに使う
  pool: { pool: DetectPool; feeder: ParallelFeeder } | null;
  parallel: boolean;
}
const streams = new Map<number, Stream>();
// 中止を頼まれた動画の解析
const videoCancels = new Set<number>();

async function streamFrame(id: number, s: Stream, img: ImageData, t: number): Promise<void> {
  // 止まっている間は飛ばして追いつく（動き出したら直前の 1 枚も処理する）
  for (const f of s.still.next(img, t)) {
    if (s.parallel && s.pool) await s.pool.feeder.push(f.img, f.t);
    else s.refiner.push(f.img, f.t);
  }
  doAnchor(id, s);
  if (s.end && performance.now() - s.end.posted > 200) {
    s.end.posted = performance.now();
    post({ type: "refine-progress", id, done: Math.max(0, t - s.end.from), total: Math.max(1, s.end.to - s.end.from) });
  }
  if (s.refiner.lastT - s.lastPartial >= 400) {
    s.lastPartial = s.refiner.lastT;
    const partial: StreamPartial = { ...s.refiner.partial(), frames: s.refiner.frames, behindMs: Math.max(0, s.fedUntil - s.refiner.lastT) };
    post({ type: "stream-partial", id, partial });
  }
}

// 完成の区切りまで解析が進んでいたら、そこまでを前後から解き直して知らせる
function doAnchor(id: number, s: Stream): void {
  const a = s.anchor;
  if (!a || s.refiner.lastT < a.t) return;
  s.anchor = undefined;
  const cp = s.refiner.checkpoint(a.t, a.target);
  if (cp) post({ type: "stream-partial", id, partial: { ...cp, frames: s.refiner.frames, behindMs: Math.max(0, s.fedUntil - s.refiner.lastT), anchored: true } });
}

// コアがこれだけあれば、ソルブ中から精密解析の検出を並列にする（メイン・ライブの認識・解析の分を残しても空いている）
const PARALLEL_LIVE_CORES = 6;
const coreCount = () => (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4;

const post = (msg: FromWorker) => (self as unknown as Worker).postMessage(msg);

// 精密解析の検出を別の Worker に分ける（src/vision/detectPool.ts）。作れない・OpenCV を読み込めないときは null（この Worker だけで）
async function parallelFeeder(refiner: Refiner, n = poolSize()): Promise<{ pool: DetectPool; feeder: ParallelFeeder } | null> {
  if (!n || typeof Worker === "undefined") return null;
  const cfg = refiner.pipelineConfig;
  let pool: DetectPool | null = null;
  try {
    pool = new DetectPool(n, { scheme: stickerScheme(cfg.stickers), design: cfg.arucoDesign ?? "standard", thorough: !!cfg.arucoThorough });
    await pool.start();
    const p = pool;
    return { pool: p, feeder: new ParallelFeeder(refiner, (img, hint) => p.detect(img, hint), n * 2) };
  } catch (e) {
    console.warn("検出を並列にできませんでした。", e);
    pool?.close();
    return null;
  }
}

function needCv(): CV {
  if (!cv) throw new Error("画像認識（OpenCV）を読み込めませんでした");
  return cv;
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "init": {
        const t0 = performance.now();
        try {
          cv = await loadOpenCv();
        } catch (e) {
          cv = null;
          console.warn("OpenCV.js を読み込めませんでした。", e);
        }
        post({ type: "ready", ms: performance.now() - t0, opencv: !!cv });
        return;
      }
      case "config":
        config = { ...config, ...msg.config };
        return;
      case "track-start":
        engine = new TrackerEngine(Uint8Array.from(msg.state), msg.refs, msg.options, msg.orients);
        focus = undefined;
        return;
      case "track-options":
        engine?.setOptions(msg.options);
        return;
      case "track-reset":
        engine?.reset(Uint8Array.from(msg.state), msg.orients);
        focus = undefined;
        return;
      case "track-stop":
        engine = null;
        focus = undefined;
        return;
      case "track-query":
        post({ type: "track-snapshot", id: msg.id, track: engine ? engine.snapshot() : null });
        return;
      case "refine": {
        // ソルブ後の精密解析（タイマー用の別の Worker で動かす。リアルタイムの追跡は止めない）
        const { recording, input, id } = msg;
        try {
          const refiner = new Refiner(needCv(), { ...input, pipeline: { ...config, ...input.pipeline } });
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
      case "track-rebase": {
        if (engine) engine.rebase(Uint8Array.from(msg.state), msg.orient, msg.moves, msg.t, msg.keep);
        return;
      }
      case "stream-feed": {
        let s = streams.get(msg.id);
        if (!s) {
          if (!msg.input) return;
          s = { refiner: new Refiner(needCv(), { ...msg.input, pipeline: { ...config, ...msg.input.pipeline } }), decoder: null, fedUntil: 0, lastPartial: -Infinity, still: new StillSkipper(), pool: null, parallel: coreCount() >= PARALLEL_LIVE_CORES };
          streams.set(msg.id, s);
          // タイマー（止めると残りを解析して確定する）だけ。フリー（keepPatchesMs）は止めないので起こさない
          const made = s;
          if (msg.input.keepPatchesMs === undefined)
            // ソルブ中から使うなら、メイン・ライブの認識・解析・もう 1 コアを残す
            parallelFeeder(made.refiner, made.parallel ? Math.min(poolSize(), coreCount() - 4) : poolSize()).then((pf) => {
              if (streams.get(msg.id) === made) made.pool = pf;
              else pf?.pool.close();
            });
        }
        const st = s;
        const rec = msg.recording;
        if (!rec.chunks.length) return;
        st.decoder ??= new StreamDecoder(rec.config, rec.width, rec.height, (img, t) => streamFrame(msg.id, st, img, t));
        st.fedUntil = Math.max(st.fedUntil, rec.chunks[rec.chunks.length - 1].timestamp / 1000);
        st.decoder.push(rec.chunks).catch((e) => {
          streams.delete(msg.id);
          post({ type: "refine-error", id: msg.id, message: e instanceof Error ? e.message : String(e) });
        });
        return;
      }
      case "stream-end": {
        const s = streams.get(msg.id);
        if (!s) {
          post({ type: "refine-error", id: msg.id, message: "解析が始まっていません" });
          return;
        }
        s.refiner.setEnd(msg.to);
        s.end = { from: s.refiner.lastT, to: msg.to, posted: 0 };
        // 止めた後はライブの認識が要らないので、残りの検出を並列にして早く確定する（起こしておいた Worker が読み込み終えていれば）
        s.parallel = true;
        try {
          const t0 = performance.now();
          const behind = s.fedUntil - s.refiner.lastT;
          await s.decoder?.flush();
          await s.pool?.feeder.flush();
          const t1 = performance.now();
          const result = s.refiner.result(msg.target ? Uint8Array.from(msg.target) : null);
          // 調査用: 止めた時点の遅れ・残りの処理・解き直しの時間
          console.info(`[analysis] behind ${behind.toFixed(0)}ms rest ${(t1 - t0).toFixed(0)}ms result ${(performance.now() - t1).toFixed(0)}ms frames ${s.refiner.frames} gated ${s.refiner.gated} pool ${s.pool?.pool.size ?? 0}`);
          post({ type: "refine-result", id: msg.id, result });
        } catch (e) {
          post({ type: "refine-error", id: msg.id, message: e instanceof Error ? e.message : String(e) });
        } finally {
          s.decoder?.close();
          s.pool?.pool.close();
          streams.delete(msg.id);
        }
        return;
      }
      case "stream-anchor": {
        const s = streams.get(msg.id);
        if (!s) return;
        s.anchor = { t: msg.t, target: Uint8Array.from(msg.target) };
        doAnchor(msg.id, s);
        return;
      }
      case "video-refine": {
        // 動画ファイルの精密解析（動画の読み込みは、使うときだけ読み込む）
        const { id, file, input, target, options } = msg;
        videoCancels.delete(id);
        try {
          const { decodeVideoFile } = await import("./videoFile");
          const refiner = new Refiner(needCv(), { ...input, pipeline: { ...config, ...input.pipeline } });
          const still = new StillSkipper();
          // 検出を別の Worker に分ける（コアが少ない・Worker を作れないときは、この Worker だけで）
          const feeder = await parallelFeeder(refiner);
          let total = 1;
          let done = 0;
          let lastPost = 0;
          await decodeVideoFile(
            file,
            {
              ...options,
              cancelled: () => videoCancels.has(id),
              onInfo: (info, analyzedFrames) => {
                total = analyzedFrames;
                post({ type: "video-info", id, info, analyzedFrames });
              },
            },
            async (img, t) => {
              for (const f of still.next(img, t)) {
                if (feeder) await feeder.feeder.push(f.img, f.t);
                else refiner.push(f.img, f.t);
              }
              done++;
              if (performance.now() - lastPost > 200) {
                lastPost = performance.now();
                post({ type: "refine-progress", id, done, total });
              }
            },
          );
          await feeder?.feeder.flush();
          feeder?.pool.close();
          if (videoCancels.has(id)) throw new Error("中止しました");
          post({ type: "refine-progress", id, done: total, total });
          post({ type: "refine-result", id, result: refiner.result(target ? Uint8Array.from(target) : null) });
        } catch (e) {
          post({ type: "refine-error", id, message: e instanceof Error ? e.message : String(e) });
        } finally {
          videoCancels.delete(id);
        }
        return;
      }
      case "detect": {
        // 検出だけ（精密解析の並列化: 解析の Worker が、この Worker を何個か作って検出を分ける）
        const b = detectorFor(needCv(), msg.scheme, msg.thorough, msg.design);
        post({ type: "detected", id: msg.id, markers: detectWithHint(b, msg.img, msg.hint) });
        return;
      }
      case "video-cancel": {
        videoCancels.add(msg.id);
        return;
      }
      case "stream-cancel": {
        streams.get(msg.id)?.decoder?.close();
        streams.get(msg.id)?.pool?.pool.close();
        streams.delete(msg.id);
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
        const result = cv ? processFrame(cv, img, msg.t, focus?.length ? { ...config, focus } : config, memory) : { faces: [], quads: [] };
        const reading = frameReading(msg.t, result);
        const track = engine?.push(reading) ?? undefined;
        if (track) focus = focusCells(track.cells, track.orient);
        let looksSolved: boolean | undefined;
        let pose: FrameMessage["pose"];
        if (engine && reading.faces.length) {
          const labels = engine.labelsOf(reading);
          looksSolved = engine.looksSolved(reading, labels);
          const p = estimatePose(result.faces, w, h);
          if (p && p.err < Math.max(4, w / 100)) {
            // 直前の 3D の向き（キューブ固定 → カメラ）に近い姿勢を優先する（見え方で区別できないときに跳ねない）
            const prev = lastPose && msg.t - lastPose.t < 1500 ? lastPose.M : null;
            const orient = engine.frameOrient(reading, labels, prev ? (o) => (0.9 * rotationAngle([...mul(p.R as Mat3, ORIENTATIONS[o])], [...prev])) / Math.PI : undefined);
            lastPose = { t: msg.t, M: mul(p.R as Mat3, ORIENTATIONS[orient]) };
            pose = { R: p.R, err: p.err, orient };
          }
        }
        post({ type: "frame", id: msg.id, t: msg.t, width: w, height: h, faces: result.faces, quads: result.quads, procMs: performance.now() - t0, track, looksSolved, pose });
        return;
      }
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
