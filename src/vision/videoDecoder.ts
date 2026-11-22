// WebCodecs で動画を 1 フレームずつ復号するときの共通の部品（録画・動画ファイル・ArUco の検証ページで使う）。
import { framePixels } from "./framePixels";
import type { PixelSource } from "./image";

export interface ChunkInit {
  type: "key" | "delta";
  timestamp: number; // µs
  duration: number; // µs（0 なら指定しない）
  data: EncodedVideoChunkInit["data"];
}

// 画素を読み出す 2D canvas（OffscreenCanvas）
export function readableCanvas(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas を使えません");
  return ctx;
}

// VideoDecoder と、復号されたフレームの列。復号が詰まったら、フレームが出てくるまで待つ
export class DecodeQueue {
  readonly pending: VideoFrame[] = [];
  error: unknown = null;
  private wake: (() => void) | null = null;
  private readonly decoder: VideoDecoder;

  constructor(config: VideoDecoderConfig) {
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

  get state(): CodecState {
    return this.decoder.state;
  }

  // 1 つ復号に回し、出てきたフレームを drain で処理する。復号待ちが maxQueue を超えている間は、フレームが出てくるのを待って処理する
  async decode(c: ChunkInit, maxQueue: number, drain: () => void | Promise<void>, stop: () => boolean = () => false): Promise<void> {
    if (this.error) throw this.error;
    this.decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, duration: c.duration || undefined, data: c.data }));
    await drain();
    while (this.decoder.decodeQueueSize > maxQueue && !this.error && !stop()) {
      await this.waitOutput();
      await drain();
    }
  }

  flush(): Promise<void> {
    return this.decoder.flush();
  }

  close(): void {
    for (const f of this.pending) f.close();
    this.pending.length = 0;
    if (this.decoder.state !== "closed") this.decoder.close();
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
}

// 精密解析で録画を復号した様子: decoded = 画素にしたフレーム、copied = そのうち canvas を通さずに YUV のまま取り出した数
// （framePixels。全部なら、手元で ffmpeg の YUV を planesToRgba に通すと同じ画素になる）、format・matrix・fullRange = 最初のフレームの形式と色の表し方
export interface DecodeInfo {
  decoded: number;
  copied: number;
  format: string | null;
  matrix: string | null;
  fullRange: boolean | null;
}

// 復号したフレームを画素にする（フレームは閉じる）。canvas を通さずに取り出せる形式なら framePixels で（取り出せなかったら以後は canvas で）
export class FramePixelReader {
  copied = 0; // canvas を通さずに取り出したフレームの数
  frames = 0; // 画素にしたフレームの数
  // 最初のフレームの形式と色の表し方（開発用の録画の書き出しで、手元で同じ画素に直すため: RefineResult.decodeInfo）
  format: string | null = null;
  matrix: string | null = null;
  fullRange: boolean | null = null;
  private copy = true;
  private readonly ctx: OffscreenCanvasRenderingContext2D;

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.ctx = readableCanvas(width, height);
  }

  // 復号の様子（RefineResult.decodeInfo）
  info(): DecodeInfo {
    return { decoded: this.frames, copied: this.copied, format: this.format, matrix: this.matrix, fullRange: this.fullRange };
  }

  async read(f: VideoFrame): Promise<PixelSource> {
    let img: PixelSource | null = null;
    if (!this.frames++) {
      this.format = f.format ?? null;
      this.matrix = f.colorSpace?.matrix ?? null;
      this.fullRange = f.colorSpace?.fullRange ?? null;
    }
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
    return img ?? this.ctx.getImageData(0, 0, this.width, this.height);
  }
}
