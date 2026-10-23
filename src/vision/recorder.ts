// タイマー計測中のカメラ映像を、WebCodecs で圧縮してメモリに残す（全フレーム・正確なタイムスタンプつき）。
// ソルブの後でこれを1フレームずつ解析し直し、手順と時刻を正確に出す（リアルタイムでは処理が追いつかないフレームも含めて）。
export interface RecordedChunk {
  type: "key" | "delta";
  timestamp: number; // µs（performance.now() と同じ時間軸）
  duration: number;
  data: ArrayBuffer;
}

export interface Recording {
  config: VideoDecoderConfig;
  chunks: RecordedChunk[];
  width: number;
  height: number;
}

// ハードウェアの圧縮が使える形式を先に試す（スマホの CPU を認識処理に残すため）。
// H.264 は Annex B（キーフレームに SPS/PPS を含む）にして、復号の設定を単純にする
const CODECS: { codec: string; hw: HardwareAcceleration }[] = [
  { codec: "avc1.42001f", hw: "prefer-hardware" },
  { codec: "vp8", hw: "prefer-hardware" },
  { codec: "vp09.00.10.08", hw: "prefer-hardware" },
  { codec: "avc1.42001f", hw: "no-preference" },
  { codec: "vp8", hw: "no-preference" },
  { codec: "vp09.00.10.08", hw: "no-preference" },
];

export class FrameRecorder {
  private encoder: VideoEncoder | null = null;
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private chunks: RecordedChunk[] = [];
  private decoderConfig: VideoDecoderConfig | null = null;
  private lastKey = -Infinity;
  private codec: string | null = null;
  recording = false;
  dropped = 0;
  frames = 0;
  width = 0;
  height = 0;

  static available(): boolean {
    return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined" && typeof VideoFrame !== "undefined" && typeof OffscreenCanvas !== "undefined";
  }

  // 録画を始める（width は解析に使う幅。カメラ映像はこの幅に縮めて圧縮する）
  async start(video: HTMLVideoElement, width = 800, keepMs = 120000): Promise<boolean> {
    if (!FrameRecorder.available() || !video.videoWidth) return false;
    this.stop();
    this.keepMs = keepMs;
    const w = Math.min(width, video.videoWidth) & ~1;
    const h = Math.round((video.videoHeight * w) / video.videoWidth) & ~1;
    for (const { codec, hw } of CODECS) {
      // realtime: ソフトウェアの圧縮でも速い設定（quality は数倍遅い）。それでも詰まったら add() で間引く
      const config: VideoEncoderConfig = {
        codec,
        width: w,
        height: h,
        bitrate: 2_500_000,
        framerate: 60,
        latencyMode: "realtime",
        hardwareAcceleration: hw,
        ...(codec.startsWith("avc1") ? { avc: { format: "annexb" as const } } : {}),
      };
      try {
        const enc = await VideoEncoder.isConfigSupported(config);
        const dec = await VideoDecoder.isConfigSupported({ codec, codedWidth: w, codedHeight: h });
        if (!enc.supported || !dec.supported) continue;
        this.codec = codec;
        this.encoder = new VideoEncoder({
          output: (chunk, meta) => {
            if (meta?.decoderConfig) this.decoderConfig = { ...meta.decoderConfig };
            const data = new ArrayBuffer(chunk.byteLength);
            chunk.copyTo(data);
            this.chunks.push({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? 0, data });
            this.trim();
          },
          error: (e) => console.warn("recorder:", e),
        });
        this.encoder.configure(config);
        break;
      } catch {
        this.encoder = null; // 次の形式を試す
      }
    }
    if (!this.encoder) return false;
    this.width = w;
    this.height = h;
    this.canvas = new OffscreenCanvas(w, h);
    this.ctx = this.canvas.getContext("2d");
    this.recording = true;
    this.chunks = [];
    this.frames = 0;
    this.dropped = 0;
    this.lastKey = -Infinity;
    return true;
  }

  // これより古いものは捨てる（インスペクション中は短く、ソルブが始まったら長くする）
  keepMs = 120000;

  // 古いものを捨てる（キーフレームから始まるように）
  private trim(): void {
    const last = this.chunks[this.chunks.length - 1];
    if (!last) return;
    const limit = last.timestamp - this.keepMs * 1000;
    let cut = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].timestamp >= limit) break;
      if (this.chunks[i].type === "key") cut = i;
    }
    if (cut > 0) this.chunks.splice(0, cut);
  }

  // カメラの1フレームを足す（t: ms、performance.now() の時間軸）
  add(video: HTMLVideoElement, t: number): void {
    if (!this.recording || !this.encoder || !this.ctx || this.encoder.state !== "configured") return;
    if (this.encoder.encodeQueueSize > 6) {
      this.dropped++; // 圧縮が追いつかない端末では間引く
      return;
    }
    this.ctx.drawImage(video, 0, 0, this.width, this.height);
    const frame = new VideoFrame(this.canvas!, { timestamp: Math.round(t * 1000) });
    const keyFrame = t - this.lastKey > 1000;
    if (keyFrame) this.lastKey = t;
    this.encoder.encode(frame, { keyFrame });
    frame.close();
    this.frames++;
  }

  async finish(): Promise<void> {
    if (!this.encoder || this.encoder.state !== "configured") return;
    try {
      await this.encoder.flush();
    } catch {
      // 失敗しても、それまでの分は使える
    }
  }

  // t0..t1（ms）を含む範囲を取り出す（先頭は t0 以前の最後のキーフレーム）
  extract(t0: number, t1: number): Recording | null {
    if (!this.decoderConfig && this.codec) this.decoderConfig = { codec: this.codec, codedWidth: this.width, codedHeight: this.height };
    if (!this.decoderConfig || !this.chunks.length) return null;
    const a = t0 * 1000;
    const b = t1 * 1000;
    let start = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].timestamp > a) break;
      if (this.chunks[i].type === "key") start = i;
    }
    const chunks = this.chunks.slice(start).filter((c) => c.timestamp <= b);
    if (!chunks.length || chunks[0].type !== "key") return null;
    return { config: this.decoderConfig, chunks, width: this.width, height: this.height };
  }

  stop(): void {
    this.recording = false;
    try {
      if (this.encoder && this.encoder.state !== "closed") this.encoder.close();
    } catch {
      // 無視
    }
    this.encoder = null;
  }

  clear(): void {
    this.stop();
    this.chunks = [];
    this.decoderConfig = null;
  }
}
