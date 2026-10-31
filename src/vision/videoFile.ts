// 動画ファイル（スマホのカメラアプリで撮ったスロー撮影など）を 1 フレームずつ復号して画素にする。精密解析の Worker で使う
// （解析 Worker が動画を読み込むときだけ読み込む）。映像はどこにも送らない。
// 時刻は「実際の時間」に直す: スロー再生用に書き出された動画（240fps で撮って 30fps の再生に変換したものなど）は、ファイルの時刻が
// 実際より長いので、撮影した fps を渡すと timeScale = ファイルの fps / 撮影した fps を掛ける。
import { type Demuxed, demuxFile, readSamples } from "../aruco/demux";

export interface VideoFileInfo {
  codec: string;
  width: number; // 表示の向き（回転後）の大きさ
  height: number;
  fps: number; // ファイルの時刻での fps
  frames: number;
  durationMs: number; // ファイルの時刻での長さ
}

export interface VideoFileOptions {
  maxSide: number; // 長辺をこれに縮める（リアルタイムの認識・録画と同じ）
  captureFps?: number; // 撮影した fps（省略時はファイルの fps のまま = ファイルの時刻が実際の時間）
  maxFps: number; // 解析するフレームの間隔の上限（実際の時間で。これより細かいフレームは間引く）
  onInfo?: (info: VideoFileInfo, analyzedFrames: number) => void;
  cancelled?: () => boolean;
}

// 何フレームに 1 枚を解析するか（実際の時間で maxFps を超えないように）
export function videoStride(captureFps: number, maxFps: number): number {
  return Math.max(1, Math.round(captureFps / Math.max(1, maxFps)));
}

// onFrame の t は実際の時間（ms、最初のフレーム = 0）
// onFrame が Promise を返したら、終わるまで次のフレームを渡さない（精密解析の並列化で、頼んだ検出が溜まりすぎないように）
export async function decodeVideoFile(file: Blob, o: VideoFileOptions, onFrame: (img: ImageData, t: number) => void | Promise<void>): Promise<number> {
  if (typeof VideoDecoder === "undefined") throw new Error("このブラウザは WebCodecs（VideoDecoder）に対応していません。最新の Chrome・Edge・Safari で開いてください");
  const d: Demuxed = await demuxFile(file);
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
  const scale = Math.min(1, o.maxSide / Math.max(dispW, dispH));
  const aw = Math.round(dispW * scale);
  const ah = Math.round(dispH * scale);
  const captureFps = o.captureFps && o.captureFps > 0 ? o.captureFps : d.fps;
  const timeScale = d.fps / captureFps;
  const stride = videoStride(captureFps, o.maxFps);
  o.onInfo?.({ codec: d.codec, width: dispW, height: dispH, fps: d.fps, frames: d.samples.length, durationMs: d.durationMs }, Math.ceil(d.samples.length / stride));

  const canvas = new OffscreenCanvas(aw, ah);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas を使えません");
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
  let index = 0;
  let count = 0;
  const cancelled = () => !!o.cancelled?.();
  const drain = async () => {
    while (pending.length && !cancelled()) {
      const f = pending.shift()!;
      try {
        if (index++ % stride !== 0) continue;
        // 表示の向きに回してから縮める
        if (d.rotation === 90) ctx.setTransform(0, scale, -scale, 0, aw, 0);
        else if (d.rotation === 180) ctx.setTransform(-scale, 0, 0, -scale, aw, ah);
        else if (d.rotation === 270) ctx.setTransform(0, -scale, scale, 0, 0, ah);
        else ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.drawImage(f, 0, 0, d.width, d.height);
        const t = ((f.timestamp - d.firstCts) / 1000) * timeScale;
        f.close();
        await onFrame(ctx.getImageData(0, 0, aw, ah), t);
        count++;
      } finally {
        f.close();
      }
    }
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
    for await (const { index: i, data } of readSamples(file, d.samples)) {
      if (cancelled()) break;
      if (error) throw error;
      const s = d.samples[i];
      decoder.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: s.cts, duration: s.duration || undefined, data }));
      await drain();
      while (decoder.decodeQueueSize > 3 && !error && !cancelled()) {
        await waitOutput();
        await drain();
      }
    }
    if (!cancelled()) {
      await decoder.flush();
      await drain();
    }
    if (error) throw error;
  } finally {
    for (const f of pending) f.close();
    if (decoder.state !== "closed") decoder.close();
  }
  return count;
}
