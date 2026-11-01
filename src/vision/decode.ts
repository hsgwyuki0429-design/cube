// 録画（WebCodecs で圧縮したもの）を1フレームずつ復号して画素にする。精密解析の Worker で使う。
import { framePixels } from "./framePixels";
import type { PixelSource } from "./image";
import type { Recording } from "./recorder";

export async function decodeRecording(rec: Recording, onFrame: (img: PixelSource, t: number) => void): Promise<number> {
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
  let copy = true; // canvas を通さずに取り出せる形式か（framePixels。だめなら以後は canvas で）
  // 復号済みのフレームを処理する（解析は重いので、溜めすぎないよう1枚ずつ閉じる）
  const drain = async () => {
    while (pending.length) {
      const f = pending.shift()!;
      const t = f.timestamp / 1000;
      let img: PixelSource | null = null;
      try {
        if (copy) {
          img = await framePixels(f, rec.width, rec.height);
          copy = !!img;
        }
        if (!img) ctx.drawImage(f, 0, 0, rec.width, rec.height);
      } finally {
        f.close();
      }
      onFrame(img ?? ctx.getImageData(0, 0, rec.width, rec.height), t);
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
      await drain();
      while (decoder.decodeQueueSize > 2 && !error) {
        await waitOutput();
        await drain();
      }
    }
    await decoder.flush();
    await drain();
  } finally {
    for (const f of pending) f.close();
    if (decoder.state !== "closed") decoder.close();
  }
  if (error) throw error;
  return count;
}

// 録画を少しずつ受け取って復号する（ソルブ中から解析を進めるとき）。push は順番に処理する
export class StreamDecoder {
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private decoder: VideoDecoder;
  private pending: VideoFrame[] = [];
  private error: unknown = null;
  private wake: (() => void) | null = null;
  private work: Promise<void> = Promise.resolve();
  frames = 0;
  copied = 0; // canvas を通さずに取り出したフレームの数（framePixels）
  private copy = true; // framePixels で取り出せる形式か（取り出せなかったら以後は canvas で）

  constructor(
    config: VideoDecoderConfig,
    private width: number,
    private height: number,
    private onFrame: (img: PixelSource, t: number) => void | Promise<void>,
  ) {
    this.canvas = new OffscreenCanvas(width, height);
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas を使えません");
    this.ctx = ctx;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.pending.push(frame);
        this.wake?.();
      },
      error: (e) => {
        this.error = e;
        this.wake?.();
      },
    });
    this.decoder.configure(config);
  }

  // onFrame が Promise を返したら待つ（検出を別の Worker に頼んでいる間は、次のフレームを復号しすぎない）
  private async drain(): Promise<void> {
    while (this.pending.length) {
      const f = this.pending.shift()!;
      const t = f.timestamp / 1000;
      let img: PixelSource | null = null;
      try {
        if (this.copy) {
          img = await framePixels(f, this.width, this.height);
          if (img) this.copied++;
          else this.copy = false;
        }
        if (!img) this.ctx.drawImage(f, 0, 0, this.width, this.height);
      } finally {
        f.close();
      }
      await this.onFrame(img ?? this.ctx.getImageData(0, 0, this.width, this.height), t);
      this.frames++;
    }
  }

  private waitOutput(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve();
      };
      setTimeout(() => this.wake?.(), 30);
    });
  }

  push(chunks: { type: "key" | "delta"; timestamp: number; duration: number; data: ArrayBuffer }[]): Promise<void> {
    this.work = this.work.then(async () => {
      for (const c of chunks) {
        if (this.error) throw this.error;
        this.decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, duration: c.duration || undefined, data: c.data }));
        await this.drain();
        while (this.decoder.decodeQueueSize > 2 && !this.error) {
          await this.waitOutput();
          await this.drain();
        }
      }
      await this.drain();
    });
    return this.work;
  }

  // 受け取った分をすべて復号し終えるまで待つ
  flush(): Promise<void> {
    this.work = this.work.then(async () => {
      if (this.decoder.state === "configured") await this.decoder.flush();
      await this.drain();
    });
    return this.work;
  }

  close(): void {
    for (const f of this.pending) f.close();
    this.pending = [];
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}
