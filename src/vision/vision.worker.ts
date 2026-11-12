// 認識 Worker: OpenCV.js（約13MB）の読み込み、1フレームの処理、追跡エンジンの実行。
// メインスレッドは描画と UI だけを受け持つ。
import { type Mat3, ORIENTATIONS, mul } from "../cube/model";
import { TrackerEngine, focusCells } from "../track/engine";
import { StreamDecoder, decodeRecording } from "./decode";
import type { Recording } from "./recorder";
import { StillSkipper } from "./motion";
import { FocalTracker, rotationAngle } from "./pose";
import { type RefineInput, Refiner } from "./refine";
import { DetectPool, ParallelFeeder, poolSize } from "./detectPool";
import { stickerScheme } from "../aruco/codes";
import { detectWithHint, detectorFor } from "./arucoFrame";
import { DEFAULT_PIPELINE, type PipelineConfig, frameReading, processFrame } from "./pipeline";
import type { FrameMessage, FromWorker, StreamPartial, ToWorker } from "./protocol";
import type { CV, PixelSource } from "./image";
import { loadOpenCv } from "./opencv";
import { errorMessage } from "../lib/util";

let cv: CV | null = null;
let config: PipelineConfig = { ...DEFAULT_PIPELINE };
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let engine: TrackerEngine | null = null;
const memory = {}; // フレームの間で引き継ぐもの（processFrame）
// 焦点距離の見積もり（カメラごとに違う。超広角は長辺の 0.4 倍ほど: src/vision/pose.ts）
const focal = new FocalTracker();
let lastPose: { t: number; M: Mat3 } | null = null; // 直前に送った 3D の向き（キューブ固定 → カメラ）
let focus: number[] | undefined; // 追跡が未確定・推定とみているマス（ArUco で先に読み直す）

// ソルブ中から進める精密解析（解析用の Worker で使う）
interface Stream {
  refiner: Refiner;
  decoder: StreamDecoder | null;
  fedUntil: number; // 受け取った録画の最後の時刻（ms）
  lastPartial: number;
  // インスペクションの間引き（下の INSPECT_*）: これより前のフレームは間引く（Infinity = まだ回し始めていない・-Infinity = 間引かない）
  fullFrom: number;
  held: Recording["chunks"]; // まだ復号に回していない録画（インスペクションの間は HOLD_MS だけ遅らせる）
  lastInspect: number; // 間引いている間に最後に処理したフレームの時刻
  still: StillSkipper;
  end?: { from: number; to: number; posted: number }; // 止めた後: 残りの解析の進み具合を知らせる
  // 検出を別の Worker に分けることはしない（動画ファイルの解析だけ）: OpenCV を読み込んだ Worker は 1 個 130MB ほどを確保するので、
  // ライブの認識・解析に加えて 2〜3 個起こすと、iPhone ではプレイ中にタブごと落ちた
}
const streams = new Map<number, Stream>();
// 中止を頼まれた動画の解析
const videoCancels = new Set<number>();

// インスペクションの間引き: 精密解析はインスペクションから進めるが、インスペクションの間はキューブを回して見ているだけで手は
// 回さない（要るのは始まりの状態の確かめと、持ち替えを追うことだけ）。全部のフレームを処理すると、回して見ている間ずっと動きが
// あって飛ばせず、処理の遅い端末では回し始める前から解析が何秒も遅れ、止めた後の待ちがその分だけ長くなっていた。
// 回し始めたと分かる（stream-solving）までのフレームは INSPECT_EVERY_MS に 1 枚だけ処理する。回し始めの判定は実際の回し始めより
// 遅れて届くので、インスペクションの間は録画を HOLD_MS だけ遅らせて復号し、届いた開始の時刻の少し前からは全部処理する
const INSPECT_EVERY_MS = 60;
const HOLD_MS = 3000;

// 録画を復号に回す（インスペクションの間は HOLD_MS より新しい分を取っておく）
function releaseChunks(id: number, s: Stream): void {
  if (!s.decoder) return;
  const until = s.fullFrom === Infinity ? (s.fedUntil - HOLD_MS) * 1000 : Infinity;
  let n = 0;
  while (n < s.held.length && s.held[n].timestamp <= until) n++;
  if (!n) return;
  s.decoder.push(s.held.splice(0, n)).catch((e) => {
    streams.delete(id);
    post({ type: "refine-error", id, message: errorMessage(e) });
  });
}

function streamFrame(id: number, s: Stream, img: PixelSource, t: number): void {
  if (t < s.fullFrom) {
    if (t - s.lastInspect < INSPECT_EVERY_MS) return;
    s.lastInspect = t;
  }
  // 止まっている間は飛ばして追いつく（動き出したら直前の 1 枚も処理する）
  for (const f of s.still.next(img, t)) s.refiner.push(f.img, f.t);
  if (s.end && performance.now() - s.end.posted > 200) {
    s.end.posted = performance.now();
    post({ type: "refine-progress", id, done: Math.max(0, t - s.end.from), total: Math.max(1, s.end.to - s.end.from) });
  }
  if (s.refiner.lastT - s.lastPartial >= 400) {
    s.lastPartial = s.refiner.lastT;
    // 遅れ（インスペクションの間は、わざと遅らせている分を除く）
    const partial: StreamPartial = { ...s.refiner.partial(), frames: s.refiner.frames, behindMs: Math.max(0, s.fedUntil - s.refiner.lastT - (s.fullFrom === Infinity ? HOLD_MS : 0)) };
    post({ type: "stream-partial", id, partial });
  }
}

const post = (msg: FromWorker) => (self as unknown as Worker).postMessage(msg);

// 解き直しの段階を本体に知らせる。解き直しの間の "decode"（動いている知らせ）は 1 秒に 1 回まで
function phasePoster(id: number): (phase: "decode" | "timing") => void {
  let last = -Infinity;
  return (phase) => {
    if (phase === "decode") {
      const now = performance.now();
      if (now - last < 1000) return;
      last = now;
    }
    post({ type: "refine-phase", id, phase });
  };
}

// 精密解析の検出を別の Worker に分ける（src/vision/detectPool.ts）。作れない・OpenCV を読み込めないときは null（この Worker だけで）
async function parallelFeeder(refiner: Refiner, n = poolSize()): Promise<{ pool: DetectPool; feeder: ParallelFeeder } | null> {
  if (!n || typeof Worker === "undefined") return null;
  const cfg = refiner.pipelineConfig;
  let pool: DetectPool | null = null;
  try {
    pool = new DetectPool(n, { scheme: stickerScheme(cfg.stickers), design: cfg.arucoDesign ?? "standard", thorough: cfg.arucoFineWindows ?? !!cfg.arucoThorough, quad: cfg.arucoQuad });
    await pool.start();
    const p = pool;
    return { pool: p, feeder: new ParallelFeeder(refiner, (img, hint) => p.detect(img, hint), n * 2) };
  } catch (e) {
    console.warn("検出を並列にできませんでした。", e);
    pool?.close();
    return null;
  }
}

// OpenCV。専用の検出だけを使うとき（init の opencv: false）は読み込んでいないので null のまま渡す（検出器を作る所で、要るのに
// なければ例外になる: src/vision/arucoFrame.ts の detectorFor）
let wantCv = true;
function needCv(): CV {
  if (!cv && wantCv) throw new Error("画像認識（OpenCV）を読み込めませんでした");
  return cv as CV;
}

// 精密解析の進み具合: 1 フレーム処理するたびに呼ぶと、200ms ごとに送る
function progressPoster(id: number, total: () => number): () => void {
  let done = 0;
  let lastPost = 0;
  return () => {
    done++;
    if (performance.now() - lastPost > 200) {
      lastPost = performance.now();
      post({ type: "refine-progress", id, done, total: total() });
    }
  };
}

// 精密解析（いまの認識の設定に、解析ごとの設定を重ねる）
const newRefiner = (input: RefineInput) => new Refiner(needCv(), { ...input, pipeline: { ...config, ...input.pipeline } });

// ライブのフレームの待ち行列: 処理している間に届いたフレームのうち、動きのいちばん小さいもの（同じくらいなら新しいもの）を処理する。
// 回している途中のフレームより、層が止まっているフレームの方が読めるマスが多く（格子で追えて検出もいらないので軽い）、追跡の観測に
// なる。合成の 10 手 × 20 本（約 6 手/秒、1 秒 5 枚）で、手順の正しさ 18 → 19/20・1 フレームの処理 36 → 21ms（tests/debug/seqBench の @f5s）
interface QueuedFrame {
  id: number;
  t: number;
  bitmap: ImageBitmap;
  motion?: number;
}
const queue: QueuedFrame[] = [];
let scheduled = false;
let thumbCtx: OffscreenCanvasRenderingContext2D | null = null;
let lastThumb: Uint8ClampedArray | null = null;
const THUMB_W = 64;
const THUMB_H = 48;
const MOTION_DIFF = 25; // 縮小画像の点の明るさがこれより変わったら動いた点
const STILLER = 0.7; // 新しいフレームより動きがこれ倍未満のときだけ、古いフレームを選ぶ

function scheduleFrames(): void {
  if (scheduled) return;
  scheduled = true;
  // 処理している間に届いたメッセージ（フレーム）を先に受け取ってから選ぶ
  setTimeout(runFrames, 0);
}

function runFrames(): void {
  scheduled = false;
  const f = pickFrame();
  if (f) {
    try {
      processLiveFrame(f);
    } catch (e) {
      post({ type: "error", message: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
    }
  }
  if (queue.length) scheduleFrames();
}

// 前に届いたフレームからの動き（縮小画像で変わった点の数）
function motionOf(bitmap: ImageBitmap): number {
  if (!thumbCtx) thumbCtx = new OffscreenCanvas(THUMB_W, THUMB_H).getContext("2d", { willReadFrequently: true });
  if (!thumbCtx) return 0;
  thumbCtx.drawImage(bitmap, 0, 0, THUMB_W, THUMB_H);
  const d = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data;
  const prev = lastThumb;
  lastThumb = d;
  if (!prev) return Infinity;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = Math.max(d[i], d[i + 1], d[i + 2]);
    const b = Math.max(prev[i], prev[i + 1], prev[i + 2]);
    if (Math.abs(a - b) > MOTION_DIFF) n++;
  }
  return n;
}

function pickFrame(): QueuedFrame | null {
  if (!queue.length) return null;
  if (queue.length > 1) for (const f of queue) f.motion ??= motionOf(f.bitmap);
  let best = queue[queue.length - 1];
  for (const f of queue) if (f.motion !== undefined && best.motion !== undefined && f.motion < best.motion * STILLER) best = f;
  for (const f of queue.splice(0)) {
    if (f === best) continue;
    f.bitmap.close();
    post({ type: "frame-skipped", id: f.id });
  }
  return best;
}

function processLiveFrame(msg: QueuedFrame): void {
  const t0 = performance.now();
  const { bitmap } = msg;
  const w = bitmap.width;
  const h = bitmap.height;
  if (!ctx || ctx.canvas.width !== w || ctx.canvas.height !== h) ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  ctx!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx!.getImageData(0, 0, w, h);
  const result = cv || !wantCv ? processFrame(cv as CV, img, msg.t, focus?.length ? { ...config, focus } : config, memory) : { faces: [], quads: [] };
  const reading = frameReading(msg.t, result);
  const track = engine?.push(reading) ?? undefined;
  if (track) focus = focusCells(track.cells, track.orient);
  let looksSolved: boolean | undefined;
  let pose: FrameMessage["pose"];
  if (engine && reading.faces.length) {
    const labels = engine.labelsOf(reading);
    looksSolved = engine.looksSolved(reading, labels);
    const p = focal.estimate(result.faces, w, h);
    if (p && p.err < Math.max(4, w / 100)) {
      // 直前の 3D の向き（キューブ固定 → カメラ）に近い姿勢を優先する（見え方で区別できないときに跳ねない）
      const prev = lastPose && msg.t - lastPose.t < 1500 ? lastPose.M : null;
      const orient = engine.frameOrient(reading, labels, prev ? (o) => (0.9 * rotationAngle([...mul(p.R as Mat3, ORIENTATIONS[o])], [...prev])) / Math.PI : undefined);
      lastPose = { t: msg.t, M: mul(p.R as Mat3, ORIENTATIONS[orient]) };
      pose = { R: p.R, err: p.err, orient };
    }
  }
  post({ type: "frame", id: msg.id, t: msg.t, width: w, height: h, faces: result.faces, quads: result.quads, procMs: performance.now() - t0, track, looksSolved, pose });
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "init": {
        const t0 = performance.now();
        wantCv = msg.opencv !== false;
        if (wantCv) {
          try {
            cv = await loadOpenCv();
          } catch (e) {
            cv = null;
            console.warn("OpenCV.js を読み込めませんでした。", e);
          }
        }
        post({ type: "ready", ms: performance.now() - t0, opencv: !!cv || !wantCv });
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
          const refiner = newRefiner(input);
          const total = recording.chunks.filter((c) => c.timestamp / 1000 >= input.from && c.timestamp / 1000 <= input.to).length;
          const progress = progressPoster(id, () => total);
          // 止まっているフレームは飛ばす（ソルブ中から進める解析と同じ。やり直しの解析を待つ時間を短く）
          const still = new StillSkipper();
          // インスペクションの間は、ソルブ中から進める解析と同じく間引く（streamFrame）
          const inspectUntil = input.inspectUntil ?? -Infinity;
          if (Number.isFinite(inspectUntil)) refiner.setInspectUntil(inspectUntil);
          let lastInspect = -Infinity;
          await decodeRecording(recording, (img, t) => {
            if (t < input.from || t > input.to) return;
            progress();
            if (t < inspectUntil) {
              if (t - lastInspect < INSPECT_EVERY_MS) return;
              lastInspect = t;
            }
            for (const f of still.next(img, t)) refiner.push(f.img, f.t);
          });
          post({ type: "refine-phase", id, phase: "decode" });
          post({ type: "refine-result", id, result: refiner.result(undefined, phasePoster(id)) });
        } catch (e) {
          post({ type: "refine-error", id, message: errorMessage(e) });
        }
        return;
      }
      case "stream-feed": {
        let s = streams.get(msg.id);
        if (!s) {
          if (!msg.input) return;
          s = { refiner: newRefiner(msg.input), decoder: null, fedUntil: 0, lastPartial: -Infinity, still: new StillSkipper(), fullFrom: msg.inspection ? Infinity : -Infinity, held: [], lastInspect: -Infinity };
          streams.set(msg.id, s);
        }
        const st = s;
        const rec = msg.recording;
        if (!rec.chunks.length) return;
        st.decoder ??= new StreamDecoder(rec.config, rec.width, rec.height, (img, t) => streamFrame(msg.id, st, img, t));
        st.fedUntil = Math.max(st.fedUntil, rec.chunks[rec.chunks.length - 1].timestamp / 1000);
        st.held.push(...rec.chunks);
        releaseChunks(msg.id, st);
        return;
      }
      case "stream-solving": {
        const s = streams.get(msg.id);
        if (!s || s.fullFrom !== Infinity) return;
        s.fullFrom = msg.from;
        s.refiner.setInspectUntil(msg.from);
        releaseChunks(msg.id, s);
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
        // 回し始めの知らせが届かないまま終わった（手動で止めたなど）: 残りは間引かない
        if (s.fullFrom === Infinity) s.fullFrom = s.refiner.lastT;
        releaseChunks(msg.id, s);
        try {
          const t0 = performance.now();
          const behind = s.fedUntil - s.refiner.lastT;
          post({ type: "refine-phase", id: msg.id, phase: "flush" });
          await s.decoder?.flush();
          const t1 = performance.now();
          post({ type: "refine-phase", id: msg.id, phase: "decode" });
          const result = s.refiner.result(msg.target ? Uint8Array.from(msg.target) : null, phasePoster(msg.id));
          // 調査用: 止めた時点の遅れ・残りの処理・解き直しの時間
          console.info(`[analysis] behind ${behind.toFixed(0)}ms rest ${(t1 - t0).toFixed(0)}ms result ${(performance.now() - t1).toFixed(0)}ms frames ${s.refiner.frames} gated ${s.refiner.gated} copied ${s.decoder?.copied ?? 0}`);
          post({ type: "refine-result", id: msg.id, result });
        } catch (e) {
          post({ type: "refine-error", id: msg.id, message: errorMessage(e) });
        } finally {
          s.decoder?.close();
          streams.delete(msg.id);
        }
        return;
      }
      case "video-refine": {
        // 動画ファイルの精密解析（動画の読み込みは、使うときだけ読み込む）
        const { id, file, input, target, options } = msg;
        videoCancels.delete(id);
        try {
          const { decodeVideoFile } = await import("./videoFile");
          const refiner = newRefiner(input);
          const still = new StillSkipper();
          // 検出を別の Worker に分ける（コアが少ない・Worker を作れないときは、この Worker だけで）
          const feeder = await parallelFeeder(refiner);
          let total = 1;
          const progress = progressPoster(id, () => total);
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
              progress();
            },
          );
          await feeder?.feeder.flush();
          feeder?.pool.close();
          if (videoCancels.has(id)) throw new Error("中止しました");
          post({ type: "refine-progress", id, done: total, total });
          post({ type: "refine-result", id, result: refiner.result(target ? Uint8Array.from(target) : null, phasePoster(id)) });
        } catch (e) {
          post({ type: "refine-error", id, message: errorMessage(e) });
        } finally {
          videoCancels.delete(id);
        }
        return;
      }
      case "detect": {
        // 検出だけ（精密解析の並列化: 解析の Worker が、この Worker を何個か作って検出を分ける）
        const b = detectorFor(needCv(), msg.scheme, msg.thorough, msg.design, msg.quad);
        post({ type: "detected", id: msg.id, markers: detectWithHint(b, msg.img, msg.hint) });
        return;
      }
      case "video-cancel": {
        videoCancels.add(msg.id);
        return;
      }
      case "stream-cancel": {
        streams.get(msg.id)?.decoder?.close();
        streams.delete(msg.id);
        return;
      }
      case "frame": {
        queue.push({ id: msg.id, t: msg.t, bitmap: msg.bitmap });
        scheduleFrames();
        return;
      }
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
