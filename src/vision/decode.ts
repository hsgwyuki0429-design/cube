// 録画（WebCodecs で圧縮したもの）を1フレームずつ復号して画素にする。精密解析の Worker で使う。
import type { PixelSource } from "./image";
import type { Recording } from "./recorder";
import { type ChunkInit, DecodeQueue, FramePixelReader } from "./videoDecoder";

export async function decodeRecording(rec: Recording, onFrame: (img: PixelSource, t: number) => void): Promise<number> {
  const reader = new FramePixelReader(rec.width, rec.height);
  const queue = new DecodeQueue(rec.config);
  let count = 0;
  // 復号済みのフレームを処理する（解析は重いので、溜めすぎないよう1枚ずつ閉じる）
  const drain = async () => {
    while (queue.pending.length) {
      const f = queue.pending.shift()!;
      const t = f.timestamp / 1000;
      onFrame(await reader.read(f), t);
      count++;
    }
  };
  try {
    for (const c of rec.chunks) await queue.decode(c, 2, drain);
    await queue.flush();
    await drain();
  } finally {
    queue.close();
  }
  if (queue.error) throw queue.error;
  return count;
}

// 録画を少しずつ受け取って復号する（ソルブ中から解析を進めるとき）。push は順番に処理する
export class StreamDecoder {
  private readonly reader: FramePixelReader;
  private readonly queue: DecodeQueue;
  private work: Promise<void> = Promise.resolve();
  frames = 0;

  constructor(
    config: VideoDecoderConfig,
    width: number,
    height: number,
    private onFrame: (img: PixelSource, t: number) => void | Promise<void>,
  ) {
    this.reader = new FramePixelReader(width, height);
    this.queue = new DecodeQueue(config);
  }

  // canvas を通さずに取り出したフレームの数（framePixels）
  get copied(): number {
    return this.reader.copied;
  }

  // onFrame が Promise を返したら待つ（検出を別の Worker に頼んでいる間は、次のフレームを復号しすぎない）
  private async drain(): Promise<void> {
    while (this.queue.pending.length) {
      const f = this.queue.pending.shift()!;
      const t = f.timestamp / 1000;
      await this.onFrame(await this.reader.read(f), t);
      this.frames++;
    }
  }

  push(chunks: ChunkInit[]): Promise<void> {
    this.work = this.work.then(async () => {
      for (const c of chunks) await this.queue.decode(c, 2, () => this.drain());
      await this.drain();
    });
    return this.work;
  }

  // 受け取った分をすべて復号し終えるまで待つ
  flush(): Promise<void> {
    this.work = this.work.then(async () => {
      if (this.queue.state === "configured") await this.queue.flush();
      await this.drain();
    });
    return this.work;
  }

  close(): void {
    this.queue.close();
  }
}
