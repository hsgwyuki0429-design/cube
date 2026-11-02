// 動画ファイル（スマホのカメラアプリで撮ったスロー撮影など）を 1 フレームずつ復号して画素にする。精密解析の Worker で使う
// （解析 Worker が動画を読み込むときだけ読み込む）。映像はどこにも送らない。
// 時刻は「実際の時間」に直す: スロー再生用に書き出された動画（240fps で撮って 30fps の再生に変換したものなど）は、ファイルの時刻が
// 実際より長いので、撮影した fps を渡すと timeScale = ファイルの fps / 撮影した fps を掛ける。
import { type Demuxed, displayGeometry, drawDisplayed, openVideo, readSamples } from "../aruco/demux";
import { DecodeQueue, readableCanvas } from "./videoDecoder";

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
  const d: Demuxed = await openVideo(file);
  const g = displayGeometry(d, o.maxSide);
  const captureFps = o.captureFps && o.captureFps > 0 ? o.captureFps : d.fps;
  const timeScale = d.fps / captureFps;
  const stride = videoStride(captureFps, o.maxFps);
  o.onInfo?.({ codec: d.codec, width: g.dispW, height: g.dispH, fps: d.fps, frames: d.samples.length, durationMs: d.durationMs }, Math.ceil(d.samples.length / stride));

  const ctx = readableCanvas(g.aw, g.ah);
  const queue = new DecodeQueue(d.config);
  let index = 0;
  let count = 0;
  const cancelled = () => !!o.cancelled?.();
  const drain = async () => {
    while (queue.pending.length && !cancelled()) {
      const f = queue.pending.shift()!;
      try {
        if (index++ % stride !== 0) continue;
        drawDisplayed(ctx, f, d, g);
        const t = ((f.timestamp - d.firstCts) / 1000) * timeScale;
        f.close();
        await onFrame(ctx.getImageData(0, 0, g.aw, g.ah), t);
        count++;
      } finally {
        f.close();
      }
    }
  };
  try {
    for await (const { index: i, data } of readSamples(file, d.samples)) {
      if (cancelled()) break;
      const s = d.samples[i];
      await queue.decode({ type: s.key ? "key" : "delta", timestamp: s.cts, duration: s.duration, data }, 3, drain, cancelled);
    }
    if (!cancelled()) {
      await queue.flush();
      await drain();
    }
    if (queue.error) throw queue.error;
  } finally {
    queue.close();
  }
  return count;
}
