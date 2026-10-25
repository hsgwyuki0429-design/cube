// ArUco 検証ページの解析 Worker: 動画ファイルを 1 フレームずつ復号し、方式ごとに ArUco を検出する。
// ライブではないので間引かない（stride を指定したときだけ）。映像はどこにも送らない。
import cvModule from "@techstark/opencv-js";
import { type CV, initOpenCv } from "../vision/quads";
import { decodeCube, facesOverTime } from "./cube";
import { ArucoBench } from "./detect";
import { demuxFile, readSamples } from "./demux";
import type { AnalyzeOptions, FromArucoWorker, ToArucoWorker } from "./protocol";
import type { FrameRecord } from "./stats";

let cv: CV | null = null;
let cancelled = false;
let busy = false;
// 直前の解析（キューブモードで面の組み立て・手順の推定をやり直すため）
let last: { frames: FrameRecord[]; width: number; height: number } | null = null;

const post = (msg: FromArucoWorker) => (self as unknown as Worker).postMessage(msg);

async function ensureCv(): Promise<CV> {
  if (!cv) cv = await initOpenCv(cvModule);
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
      );
      const result = decodeCube(cubeFrames, msg.endSolved);
      post({ type: "cube", faces: cubeFrames.map((f) => f.faces), result });
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
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};

async function analyze(file: Blob, opt: AnalyzeOptions): Promise<void> {
  const t0 = performance.now();
  const cvm = await ensureCv();
  if (typeof VideoDecoder === "undefined") throw new Error("このブラウザは WebCodecs（VideoDecoder）に対応していません。最新の Chrome・Edge・Safari で開いてください");
  const d = await demuxFile(file);
  const support = await VideoDecoder.isConfigSupported(d.config).catch(() => ({ supported: false }));
  if (!support.supported) {
    const hevc = /^(hvc1|hev1)/.test(d.codec);
    throw new Error(
      `このブラウザでは ${d.codec} を復号できません。` +
        (hevc ? "HEVC（iPhone の「高効率」）は、Safari か、ハードウェア復号のある端末の Chrome で開いてください。" : "別のブラウザで試してください。"),
    );
  }
  const rotated = d.rotation === 90 || d.rotation === 270;
  const dispW = rotated ? d.height : d.width;
  const dispH = rotated ? d.width : d.height;
  const scale = opt.maxSide > 0 ? Math.min(1, opt.maxSide / Math.max(dispW, dispH)) : 1;
  const aw = Math.round(dispW * scale);
  const ah = Math.round(dispH * scale);
  post({
    type: "info",
    info: { codec: d.codec, width: dispW, height: dispH, rotation: d.rotation, samples: d.samples.length, fps: d.fps, durationMs: d.durationMs, analyzedWidth: aw, analyzedHeight: ah },
  });

  const canvas = new OffscreenCanvas(aw, ah);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas を使えません");
  const bench = new ArucoBench(cvm, opt.configs);
  const all: FrameRecord[] = [];
  last = { frames: all, width: aw, height: ah };
  const stride = Math.max(1, Math.floor(opt.stride));
  const pending: VideoFrame[] = [];
  let error: unknown = null;
  let wake: (() => void) | null = null;
  const decoder = new VideoDecoder({
    output: (f) => {
      pending.push(f);
      wake?.();
    },
    error: (e) => {
      error = e;
      wake?.();
    },
  });
  decoder.configure(d.config);

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
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // 表示の向きに回してから縮める（オーバーレイと動画の表示を合わせる）
      if (d.rotation === 90) ctx.setTransform(0, scale, -scale, 0, aw, 0);
      else if (d.rotation === 180) ctx.setTransform(-scale, 0, 0, -scale, aw, ah);
      else if (d.rotation === 270) ctx.setTransform(0, -scale, scale, 0, 0, ah);
      else ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.drawImage(f, 0, 0, d.width, d.height);
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
    while (pending.length && !cancelled) process(pending.shift()!);
  };
  const waitOutput = () =>
    new Promise<void>((resolve) => {
      wake = () => {
        wake = null;
        resolve();
      };
      setTimeout(() => wake?.(), 30);
    });

  try {
    for await (const { index, data } of readSamples(file, d.samples)) {
      if (cancelled) break;
      if (error) throw error;
      const s = d.samples[index];
      decoder.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: s.cts, duration: s.duration || undefined, data }));
      drain();
      while (decoder.decodeQueueSize > 3 && !error && !cancelled) {
        await waitOutput();
        drain();
      }
    }
    if (!cancelled) {
      await decoder.flush();
      drain();
    }
    if (error) throw error;
  } finally {
    for (const f of pending) f.close();
    if (decoder.state !== "closed") decoder.close();
    bench.delete();
  }
  flushBatch(true);
  post({ type: "progress", done: outIndex, total: d.samples.length, elapsedMs: performance.now() - t0 });
  post({ type: "done", frames: analyzed, cancelled });
}
