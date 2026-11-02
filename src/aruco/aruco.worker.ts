// ArUco 検証ページの解析 Worker: 動画ファイルを 1 フレームずつ復号し、方式ごとに ArUco を検出する。
// ライブではないので間引かない（stride を指定したときだけ）。映像はどこにも送らない。
import type { CV } from "../vision/image";
import { loadOpenCv } from "../vision/opencv";
import { DecodeQueue, readableCanvas } from "../vision/videoDecoder";
import { decodeCube, facesOverTime } from "./cube";
import { type StickerDesign, designOf } from "./design";
import { ArucoBench } from "./detect";
import { displayGeometry, drawDisplayed, openVideo, readSamples } from "./demux";
import type { AnalyzeOptions, FromArucoWorker, ToArucoWorker } from "./protocol";
import type { FrameRecord } from "./stats";
import { errorMessage } from "../lib/util";

let cv: CV | null = null;
let cancelled = false;
let busy = false;
// 直前の解析（キューブモードで面の組み立て・手順の推定をやり直すため）
let last: { frames: FrameRecord[]; width: number; height: number; scheme: AnalyzeOptions["scheme"]; design: StickerDesign } | null = null;

const post = (msg: FromArucoWorker) => (self as unknown as Worker).postMessage(msg);

async function ensureCv(): Promise<CV> {
  if (!cv) cv = await loadOpenCv();
  return cv;
}

self.onmessage = async (event: MessageEvent<ToArucoWorker>) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      const t0 = performance.now();
      await ensureCv();
      post({ type: "ready", ms: performance.now() - t0 });
    } else if (msg.type === "cancel") {
      cancelled = true;
    } else if (msg.type === "cube") {
      if (!last) throw new Error("先に動画を解析してください");
      const cubeFrames = facesOverTime(
        last.frames.map((f) => ({ t: f.t * msg.timeScale, markers: f.results[msg.config]?.markers ?? [] })),
        { width: last.width, height: last.height },
        last.scheme,
        last.design,
      );
      const result = decodeCube(cubeFrames, msg.endSolved);
      post({ type: "cube", faces: cubeFrames.map((f) => f.faces), turns: cubeFrames.map((f) => f.turn ?? null), result });
    } else if (msg.type === "analyze") {
      if (busy) throw new Error("解析中です");
      busy = true;
      cancelled = false;
      try {
        await analyze(msg.file, msg.options);
      } finally {
        busy = false;
      }
    }
  } catch (e) {
    post({ type: "error", message: errorMessage(e) });
  }
};

async function analyze(file: Blob, opt: AnalyzeOptions): Promise<void> {
  const t0 = performance.now();
  const cvm = await ensureCv();
  const d = await openVideo(file);
  const geo = displayGeometry(d, opt.maxSide > 0 ? opt.maxSide : Infinity);
  const { dispW, dispH, aw, ah } = geo;
  post({
    type: "info",
    info: { codec: d.codec, width: dispW, height: dispH, rotation: d.rotation, samples: d.samples.length, fps: d.fps, durationMs: d.durationMs, analyzedWidth: aw, analyzedHeight: ah },
  });

  const ctx = readableCanvas(aw, ah);
  const design = designOf(opt.design ?? "standard");
  const bench = new ArucoBench(cvm, opt.configs, opt.scheme, design);
  const all: FrameRecord[] = [];
  last = { frames: all, width: aw, height: ah, scheme: opt.scheme, design };
  const stride = Math.max(1, Math.floor(opt.stride));
  const queue = new DecodeQueue(d.config);

  let outIndex = 0;
  let analyzed = 0;
  let batch: FrameRecord[] = [];
  let lastPost = performance.now();
  const flushBatch = (force = false) => {
    const now = performance.now();
    if (!batch.length || (!force && now - lastPost < 200)) return;
    post({ type: "frames", items: batch });
    post({ type: "progress", done: outIndex, total: d.samples.length, elapsedMs: now - t0 });
    batch = [];
    lastPost = now;
  };

  const process = (f: VideoFrame) => {
    try {
      if (outIndex++ % stride !== 0) return;
      // 表示の向きに回してから縮める（オーバーレイと動画の表示を合わせる）
      drawDisplayed(ctx, f, d, geo);
      const img = ctx.getImageData(0, 0, aw, ah);
      const rec = { t: (f.timestamp - d.firstCts) / 1000, results: bench.detect(img) };
      batch.push(rec);
      all.push(rec);
      analyzed++;
    } finally {
      f.close();
    }
    flushBatch();
  };
  const drain = () => {
    while (queue.pending.length && !cancelled) process(queue.pending.shift()!);
  };

  try {
    for await (const { index, data } of readSamples(file, d.samples)) {
      if (cancelled) break;
      const s = d.samples[index];
      await queue.decode({ type: s.key ? "key" : "delta", timestamp: s.cts, duration: s.duration, data }, 3, drain, () => cancelled);
    }
    if (!cancelled) {
      await queue.flush();
      drain();
    }
    if (queue.error) throw queue.error;
  } finally {
    queue.close();
    bench.delete();
  }
  flushBatch(true);
  post({ type: "progress", done: outIndex, total: d.samples.length, elapsedMs: performance.now() - t0 });
  post({ type: "done", frames: analyzed, cancelled });
}
