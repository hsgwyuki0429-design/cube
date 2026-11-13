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
// H.264 は Annex B（キーフレームに SPS/PPS を含む）にして、復号の設定を単純にする。Baseline の Level 3.2（avc1.420020）を先に:
// 3.1（42001f）は 720p を 30fps までしか想定していない（60fps で録る）
const CODECS: { codec: string; hw: HardwareAcceleration }[] = [
  { codec: "avc1.420020", hw: "prefer-hardware" },
  { codec: "avc1.42001f", hw: "prefer-hardware" },
  { codec: "vp8", hw: "prefer-hardware" },
  { codec: "vp09.00.10.08", hw: "prefer-hardware" },
  { codec: "avc1.420020", hw: "no-preference" },
  { codec: "avc1.42001f", hw: "no-preference" },
  { codec: "vp8", hw: "no-preference" },
  { codec: "vp09.00.10.08", hw: "no-preference" },
];

// 圧縮の強さ（ビット/秒）。2.5Mbps では、実物のソルブ（マーカーの辺 19〜31 画素）で 1 フレームに ID が読めるマスが元の画質の 8 割
// （7.6〜8.0 → 6.1〜6.6）に減り、精密解析が完成までつながらない・解き直しが 16 秒かかることがあった。5Mbps で 7.1〜7.4 に戻り、
// どちらも 1 秒ほどで完成までつながった。8Mbps は 5Mbps よりさらに元の画質に近い（実物のソルブ 5 本で 1 本あたり +0.1〜0.6 マス、
// 精密解析はどちらも 5 本とも正しい手順）ので 8Mbps から始め、端末に合わせて下げる（下の「端末に合わせる」）
export const BITRATES = [8_000_000, 5_000_000];
// 端末に合わせる: 録画の圧縮が追いつかずに間引いたフレームが多かった（DROP_RATE より多い）・解析中にタブごと落ちた（メモリ: 下の
// MAX_BYTES）ときは、次の録画から 1 段下げて端末に覚える。下げた後も、問題なく録画できた回が RAISE_AFTER 回続いたら 1 段戻して試す
const LEVEL_KEY = "cubevision.recordBitrate";
const DROP_RATE = 0.03;
const DROP_MIN_FRAMES = 120; // これより短い録画では決めない
const RAISE_AFTER = 30;
// 録画を残す量の上限（バイト）。タイマーの録画は 150 秒まで残すので、8Mbps では 150MB になる。iPhone はメモリが足りないとタブごと
// 落ちるので、以前（5Mbps × 150 秒 ≒ 94MB）と同じくらいまでにする（古い方から捨てる。解析はソルブ中から少しずつ渡しているので、
// 捨てた所が要るのは 100 秒を超えるソルブで解析をやり直したときだけ）
const MAX_BYTES = 100_000_000;

interface LevelState {
  level: number; // BITRATES の番号
  clean: number; // 下げた後、問題なく録画できた回数
}

function readLevel(): LevelState {
  try {
    const v = JSON.parse(localStorage.getItem(LEVEL_KEY) ?? "null") as LevelState | null;
    if (v && Number.isInteger(v.level) && v.level >= 0 && v.level < BITRATES.length) return { level: v.level, clean: v.clean | 0 };
  } catch {
    // 読めなければ最初の段
  }
  return { level: 0, clean: 0 };
}

function writeLevel(s: LevelState): void {
  try {
    localStorage.setItem(LEVEL_KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても録画は続ける
  }
}

// 解析中に落ちた（src/app/crashGuard.ts の checkLastRun で分かった）: 録画の画質を 1 段下げる
export function lowerRecordBitrate(): void {
  const s = readLevel();
  writeLevel({ level: Math.min(BITRATES.length - 1, s.level + 1), clean: 0 });
}

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
  bitrate = 0; // いまの録画の圧縮の強さ（調査用）
  private bytes = 0; // 残している録画の大きさ
  width = 0;
  height = 0;

  static available(): boolean {
    return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined" && typeof VideoFrame !== "undefined" && typeof OffscreenCanvas !== "undefined";
  }

  // 録画を始める（size は解析に使う大きさ。カメラ映像は長辺をこれに縮めて圧縮する。リアルタイムの認識と同じ大きさ:
  // 幅を基準にすると、縦向きの映像では画素が 3 倍近くになり、精密解析がその分遅かった）
  async start(video: HTMLVideoElement, size = 800, keepMs = 120000): Promise<boolean> {
    if (!FrameRecorder.available() || !video.videoWidth) return false;
    this.stop();
    this.keepMs = keepMs;
    const s = Math.min(1, size / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * s) & ~1;
    const h = Math.round(video.videoHeight * s) & ~1;
    // 端末に覚えた段から。その段の圧縮の強さに対応していなければ、形式ごとに下の段も試す
    const from = readLevel().level;
    const tries = CODECS.flatMap((c) => BITRATES.slice(from).map((bitrate) => ({ ...c, bitrate })));
    for (const { codec, hw, bitrate } of tries) {
      // realtime: ソフトウェアの圧縮でも速い設定（quality は数倍遅い）。それでも詰まったら add() で間引く
      const config: VideoEncoderConfig = {
        codec,
        width: w,
        height: h,
        bitrate,
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
        this.bitrate = bitrate;
        this.encoder = new VideoEncoder({
          output: (chunk, meta) => {
            if (meta?.decoderConfig) this.decoderConfig = { ...meta.decoderConfig };
            const data = new ArrayBuffer(chunk.byteLength);
            chunk.copyTo(data);
            this.chunks.push({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? 0, data });
            this.bytes += data.byteLength;
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
    this.bytes = 0;
    this.takenUs = -Infinity;
    this.frames = 0;
    this.dropped = 0;
    this.lastKey = -Infinity;
    this.added = [];
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
    let bytes = this.bytes;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].timestamp >= limit && bytes <= MAX_BYTES) break;
      if (this.chunks[i].type === "key" && i > 0) {
        cut = i;
        if (this.chunks[i].timestamp >= limit && bytes <= MAX_BYTES) break;
      }
      bytes -= this.chunks[i].data.byteLength;
    }
    if (cut > 0) {
      for (let i = 0; i < cut; i++) this.bytes -= this.chunks[i].data.byteLength;
      this.chunks.splice(0, cut);
    }
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
    this.added.push(frame.timestamp);
    if (this.added.length > 16) this.added.shift();
    frame.close();
    this.frames++;
  }

  // untilMs: 解析に使うのはこの時刻まで。そこまでに圧縮に回したフレームが出てきたら、残りの圧縮（flush）を待たずに返す
  // （ソフトウェアの圧縮では flush に 1 秒ほどかかり、止めてから確定するまでがその分遅れていた）
  async finish(untilMs = Infinity): Promise<void> {
    if (!this.encoder || this.encoder.state !== "configured") return;
    const needUs = this.added.filter((us) => us <= untilMs * 1000).pop();
    if (needUs !== undefined && Number.isFinite(untilMs)) {
      const t0 = performance.now();
      while (performance.now() - t0 < 3000 && this.encoder.state === "configured") {
        const last = this.chunks[this.chunks.length - 1];
        if (last && last.timestamp >= needUs) return;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    try {
      // flush が返ってこない端末があっても先へ進む（それまでの分で解析する。待ち続けると結果がいつまでも出ない）
      await Promise.race([this.encoder.flush(), new Promise((r) => setTimeout(r, 4000))]);
    } catch {
      // 失敗しても、それまでの分は使える
    }
  }
  private added: number[] = []; // 最近圧縮に回したフレームの時刻（µs。finish で待つ所を決める）

  private takenUs = -Infinity;

  // 前回から増えた分（ソルブ中から解析を進めるために少しずつ渡す）。最初はキーフレームから。untilMs より後は次回に回す
  takeNew(untilMs = Infinity): Recording | null {
    const config = this.config();
    if (!config) return null;
    let start = this.chunks.findIndex((c) => c.timestamp > this.takenUs);
    if (start < 0) return { config, chunks: [], width: this.width, height: this.height };
    if (this.takenUs === -Infinity) while (start < this.chunks.length && this.chunks[start].type !== "key") start++;
    const chunks = this.chunks.slice(start).filter((c) => c.timestamp <= untilMs * 1000);
    if (chunks.length) this.takenUs = chunks[chunks.length - 1].timestamp;
    return { config, chunks, width: this.width, height: this.height };
  }

  private config(): VideoDecoderConfig | null {
    if (!this.decoderConfig && this.codec) this.decoderConfig = { codec: this.codec, codedWidth: this.width, codedHeight: this.height };
    return this.decoderConfig;
  }

  // t0..t1（ms）を含む範囲を取り出す（先頭は t0 以前の最後のキーフレーム）
  extract(t0: number, t1: number): Recording | null {
    this.config();
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
    if (this.recording) this.judge();
    this.recording = false;
    try {
      if (this.encoder && this.encoder.state !== "closed") this.encoder.close();
    } catch {
      // 無視
    }
    this.encoder = null;
  }

  // 録画を終えたとき: 圧縮が追いつかずに間引いたフレームが多ければ次から 1 段下げ、問題なければ数える（下げた段から戻すため）
  private judge(): void {
    const total = this.frames + this.dropped;
    if (total < DROP_MIN_FRAMES) return;
    const s = readLevel();
    const at = BITRATES.indexOf(this.bitrate);
    if (at < 0) return;
    if (this.dropped / total > DROP_RATE) {
      if (at >= s.level && at < BITRATES.length - 1) writeLevel({ level: at + 1, clean: 0 });
    } else if (s.level > 0 && at === s.level) {
      const clean = s.clean + 1;
      writeLevel(clean >= RAISE_AFTER ? { level: s.level - 1, clean: 0 } : { level: s.level, clean });
    }
  }

  clear(): void {
    this.stop();
    this.chunks = [];
    this.bytes = 0;
    this.takenUs = -Infinity;
    this.decoderConfig = null;
  }
}
