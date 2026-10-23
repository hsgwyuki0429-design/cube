// 録画（WebCodecs で圧縮したもの）を1フレームずつ復号して画素にする。精密解析の Worker で使う。
import type { Recording } from "./recorder";

export async function decodeRecording(rec: Recording, onFrame: (img: ImageData, t: number) => void): Promise<number> {
  const canvas = new OffscreenCanvas(rec.width, rec.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas を使えません");
  const pending: VideoFrame[] = [];
  let error: unknown = null;
  let wake: (() => void) | null = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      pending.push(frame);
      wake?.();
    },
    error: (e) => {
      error = e;
      wake?.();
    },
  });
  decoder.configure(rec.config);
  let count = 0;
  // 復号済みのフレームを処理する（解析は重いので、溜めすぎないよう1枚ずつ閉じる）
  const drain = () => {
    while (pending.length) {
      const f = pending.shift()!;
      const t = f.timestamp / 1000;
      try {
        ctx.drawImage(f, 0, 0, rec.width, rec.height);
      } finally {
        f.close();
      }
      onFrame(ctx.getImageData(0, 0, rec.width, rec.height), t);
      count++;
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
    for (const c of rec.chunks) {
      if (error) throw error;
      decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, duration: c.duration || undefined, data: c.data }));
      drain();
      while (decoder.decodeQueueSize > 2 && !error) {
        await waitOutput();
        drain();
      }
    }
    await decoder.flush();
    drain();
  } finally {
    for (const f of pending) f.close();
    if (decoder.state !== "closed") decoder.close();
  }
  if (error) throw error;
  return count;
}
