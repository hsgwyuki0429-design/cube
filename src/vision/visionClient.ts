// 認識 Worker のクライアント。空いているときだけ最新フレームを送る（詰まったら間引く）。
import { markerSize, stickerScheme } from "../aruco/codes";
import { STICKERS, designOf } from "../aruco/design";
import type { EngineOptions, TrackUpdate } from "../track/engine";
import type { Lab } from "./color";
import type { PipelineConfig } from "./pipeline";
import type { FrameMessage, FromWorker, StreamPartial, ToWorker, VideoRefineOptions } from "./protocol";
import type { Recording } from "./recorder";
import type { RefineInput, RefineResult } from "./refine";
import type { VideoFileInfo } from "./videoFile";

// Worker に送って結果がまだ来ていないフレームの上限。Worker は待っているフレームのうち動きのいちばん小さいものを処理する
// （src/vision/vision.worker.ts の pickFrame）。処理が速ければ待つフレームはほとんどない
const MAX_INFLIGHT = 3;

// 認識を Worker 2 つで交互に処理する（src/vision/vision.worker.ts の「認識を Worker 2 つで」）: ライブは処理できる枚数がそのまま
// 正確さになる（実物の 7 本の平均で、1 秒 10 枚 69.0%・20 枚 80.9%）。補助の Worker は認識だけをし、追跡は主の Worker が送った順に入れる。
// コアが少ない端末では作らない。補助の Worker が落ちたら主の Worker だけで続ける
const HELPER_MIN_CORES = 4;
const MAX_INFLIGHT_EACH = 2; // Worker 2 つのとき、それぞれに送って結果がまだ来ていないフレームの上限

// 本体のステッカー（3×3 の符号を 4 個）は専用の検出（src/aruco/quadDetect.ts）で読むので、認識の Worker は OpenCV を読み込まない
// （約 4MB の読み込みと、Worker 1 個あたり 134MB のヒープがいらない。src/vision/arucoFrame.ts の usesQuad と同じ条件）
const NEEDS_OPENCV = !(markerSize(stickerScheme(STICKERS.stickers)) === 3 && designOf(STICKERS.arucoDesign).at.length === 4);

export class VisionClient {
  private worker: Worker;
  // Worker に送って結果がまだ来ていないフレームの数。MAX_INFLIGHT まで送る（処理している間に次のフレームを Worker に待たせておく）:
  // 1 枚ずつだと、結果が返ってから次のカメラのフレームが来て画像にして送るまで（平均で半フレーム + 数 ms）Worker が空いていた
  private inflight = 0;
  private nextId = 1;
  // 補助の Worker（認識だけ）
  private helper: Worker | null = null;
  private helperReady = false;
  private helperInflight = 0;
  private nextSeq = 1;
  helperFrames = 0; // 補助の Worker が認識したフレームの数（調査用）
  // 補助の Worker に送ってよいか（録画の圧縮が詰まっている間は休ませる: 精密解析の録画の方が大事。controller が決める）
  useHelper = true;
  private listeners = new Set<(m: FrameMessage) => void>();
  private procTimes: number[] = [];
  private fallbackCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private queries = new Map<number, (t: TrackUpdate | null) => void>();
  readonly ready: Promise<{ opencv: boolean; ms: number }>;
  isReady = false;
  opencv = false;
  workWidth = 1280;
  procFps = 0;
  processed = 0; // 処理したフレームの数（調査用）
  skipped = 0; // 待っている間に、より動きの小さいフレームを選んで処理しなかった数
  lastProcMs = 0;
  lastError: string | null = null;

  constructor() {
    this.worker = new Worker(new URL("./vision.worker.ts", import.meta.url), { type: "module" });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === "ready") {
          this.isReady = true;
          this.opencv = m.opencv;
          resolve({ opencv: m.opencv, ms: m.ms });
        } else if (m.type === "error") {
          this.lastError = m.message;
          console.error("vision worker:", m.message);
          if (!this.isReady) reject(new Error(m.message));
          this.inflight = 0;
        } else if (m.type === "frame-skipped") {
          this.inflight = Math.max(0, this.inflight - 1);
          this.skipped++;
        } else if (m.type === "frame") {
          if (m.foreign) this.helperFrames++;
          else this.inflight = Math.max(0, this.inflight - 1);
          this.processed++;
          this.lastProcMs = m.procMs;
          const now = performance.now();
          this.procTimes.push(now);
          while (this.procTimes.length && now - this.procTimes[0] > 1000) this.procTimes.shift();
          this.procFps = this.procTimes.length;
          for (const l of this.listeners) l(m);
        } else if (m.type === "track-snapshot") {
          this.queries.get(m.id)?.(m.track);
          this.queries.delete(m.id);
        } else if (m.type === "live-log") {
          this.logQueries.get(m.id)?.(m.log);
          this.logQueries.delete(m.id);
        }
      };
      this.worker.onerror = (e) => {
        this.lastError = e.message;
        console.error("vision worker:", e.message);
        if (!this.isReady) reject(new Error(e.message));
        this.inflight = 0; // 処理中のフレームの結果は来ないので、次のフレームを送れるようにする
      };
    });
    this.post({ type: "init", opencv: NEEDS_OPENCV });
    this.startHelper();
  }

  private startHelper(): void {
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 0 : 0;
    if (cores < HELPER_MIN_CORES) return;
    try {
      const w = new Worker(new URL("./vision.worker.ts", import.meta.url), { type: "module" });
      this.helper = w;
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === "ready") this.helperReady = true;
        else if (m.type === "recognized") {
          this.helperInflight = Math.max(0, this.helperInflight - 1);
          this.worker.postMessage({ type: "foreign", id: m.id, seq: m.seq, t: m.t, width: m.width, height: m.height, result: m.result, procMs: m.procMs } satisfies ToWorker);
        } else if (m.type === "frame-skipped") {
          this.helperInflight = Math.max(0, this.helperInflight - 1);
          this.skipped++;
          if (m.seq !== undefined) this.worker.postMessage({ type: "foreign-skip", seq: m.seq } satisfies ToWorker);
        } else if (m.type === "error") this.dropHelper(m.message);
      };
      w.onerror = (e) => this.dropHelper(e.message);
      w.postMessage({ type: "init", opencv: NEEDS_OPENCV } satisfies ToWorker);
    } catch (e) {
      this.dropHelper(String(e));
    }
  }

  // 補助の Worker が使えない: 主の Worker だけで続ける（送ってあったフレームは、主の Worker が待ちきれずに飛ばす）
  private dropHelper(message: string): void {
    console.warn("vision helper:", message);
    this.helperReady = false;
    this.helperInflight = 0;
    try {
      this.helper?.terminate();
    } catch {
      // 無視
    }
    this.helper = null;
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  onResult(cb: (m: FrameMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async submit(video: HTMLVideoElement, t: number): Promise<boolean> {
    if (!this.isReady || !video.videoWidth) return false;
    // 送り先: 補助の Worker があれば、送って結果の来ていない数の少ない方（同じなら主）
    const both = this.helperReady && !!this.helper && this.useHelper;
    const toHelper = both && this.helperInflight < this.inflight && this.helperInflight < MAX_INFLIGHT_EACH;
    if (!toHelper && this.inflight >= (both ? MAX_INFLIGHT_EACH : MAX_INFLIGHT)) return false;
    if (toHelper) this.helperInflight++;
    else this.inflight++;
    const seq = this.nextSeq++;
    try {
      // 長辺を workWidth に（縦向きの映像で幅を基準にすると画素が 3 倍になり、認識が追いつかない）
      const s = Math.min(1, this.workWidth / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.round(video.videoWidth * s);
      const h = Math.round(video.videoHeight * s);
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: "low" });
      } catch {
        // resize オプション非対応のブラウザ向け
        if (!this.fallbackCanvas) this.fallbackCanvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : document.createElement("canvas");
        this.fallbackCanvas.width = w;
        this.fallbackCanvas.height = h;
        const ctx = this.fallbackCanvas.getContext("2d") as CanvasRenderingContext2D;
        ctx.drawImage(video, 0, 0, w, h);
        bitmap = await createImageBitmap(this.fallbackCanvas);
      }
      if (toHelper && this.helper) this.helper.postMessage({ type: "recognize", id: this.nextId++, t, bitmap, seq } satisfies ToWorker, [bitmap]);
      else this.post({ type: "frame", id: this.nextId++, t, bitmap, seq }, [bitmap]);
      return true;
    } catch (e) {
      if (toHelper) {
        this.helperInflight = Math.max(0, this.helperInflight - 1);
        this.worker.postMessage({ type: "foreign-skip", seq } satisfies ToWorker);
      } else this.inflight = Math.max(0, this.inflight - 1);
      this.lastError = String(e);
      return false;
    }
  }

  setConfig(config: Partial<PipelineConfig>): void {
    this.post({ type: "config", config });
    this.helper?.postMessage({ type: "config", config } satisfies ToWorker);
  }

  startTracking(state: ArrayLike<number>, refs: Lab[], options: Partial<EngineOptions>, orients?: number[]): void {
    this.post({ type: "track-start", state: Array.from(state), refs, options, orients });
  }

  setTrackingOptions(options: Partial<EngineOptions>): void {
    this.post({ type: "track-options", options });
  }

  resetTracking(state: ArrayLike<number>, orients?: number[]): void {
    this.post({ type: "track-reset", state: Array.from(state), orients });
  }

  stopTracking(): void {
    this.post({ type: "track-stop" });
  }

  // ライブの記録（src/track/liveLog.ts）をもらう
  private logQueries = new Map<number, (log: unknown) => void>();
  liveLog(): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.logQueries.set(id, resolve);
      this.post({ type: "live-log", id });
      setTimeout(() => {
        if (this.logQueries.delete(id)) resolve(null);
      }, 10000);
    });
  }

  // 観測を待たずに、今の追跡結果（各手の時刻はその時点までのフレームから）をもらう
  query(): Promise<TrackUpdate | null> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.queries.set(id, resolve);
      this.post({ type: "track-query", id });
      setTimeout(() => {
        if (this.queries.delete(id)) resolve(null);
      }, 2000);
    });
  }
}

// ソルブ後の精密解析を、リアルタイムの認識とは別の Worker で動かす（追跡を止めない）。
// Worker は OpenCV の読み込みに時間がかかるので、しばらく使い回してから閉じる。
export class RefineClient {
  // 解析の段階（止めた後の解析で、落ちたときにどこで落ちたかを残す: src/app/crashGuard.ts）
  onPhase: ((phase: "flush" | "decode" | "timing") => void) | null = null;
  private worker: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private idleTimer = 0;
  private nextId = 1;
  private jobs = new Map<number, { resolve: (r: RefineResult) => void; reject: (e: Error) => void; progress?: (p: number) => void }>();

  private ensure(): Promise<boolean> {
    if (this.worker && this.ready) return this.ready;
    const worker = new Worker(new URL("./vision.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    this.ready = new Promise((resolve) => {
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === "ready") resolve(m.opencv);
        else if (m.type === "refine-progress") this.jobs.get(m.id)?.progress?.(Math.min(1, m.done / Math.max(1, m.total)));
        else if (m.type === "refine-phase") this.onPhase?.(m.phase);
        else if (m.type === "stream-partial") this.partialListeners.get(m.id)?.(m.partial);
        else if (m.type === "video-info") this.infoListeners.get(m.id)?.(m.info, m.analyzedFrames);
        else if (m.type === "refine-result") this.settle(m.id, (j) => j.resolve(m.result));
        else if (m.type === "refine-error") this.settle(m.id, (j) => j.reject(new Error(m.message)));
        else if (m.type === "error") for (const id of [...this.jobs.keys()]) this.settle(id, (j) => j.reject(new Error(m.message)));
      };
      worker.onerror = (e) => {
        resolve(false);
        for (const id of [...this.jobs.keys()]) this.settle(id, (j) => j.reject(new Error(e.message || "worker error")));
        this.close();
      };
    });
    worker.postMessage({ type: "init", opencv: NEEDS_OPENCV } satisfies ToWorker);
    return this.ready;
  }

  private settle(id: number, f: (j: { resolve: (r: RefineResult) => void; reject: (e: Error) => void }) => void): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    f(job);
    if (!this.jobs.size) {
      clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => this.close(), 90000);
    }
  }

  async run(recording: Recording, input: RefineInput, progress?: (p: number) => void): Promise<RefineResult> {
    clearTimeout(this.idleTimer);
    const opencv = await this.ensure();
    if (!opencv || !this.worker) throw new Error("画像認識（OpenCV）を読み込めませんでした");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, progress });
      this.worker!.postMessage({ type: "refine", id, recording, input } satisfies ToWorker);
    });
  }

  // ---- 動画ファイルの解析 ----

  private infoListeners = new Map<number, (info: VideoFileInfo, analyzedFrames: number) => void>();

  // 動画ファイル（スロー撮影など）を精密解析する。cancel() で中止（結果は「中止しました」のエラー）
  runVideo(
    file: Blob,
    input: RefineInput,
    target: ArrayLike<number> | null,
    options: VideoRefineOptions,
    progress?: (p: number) => void,
    onInfo?: (info: VideoFileInfo, analyzedFrames: number) => void,
  ): { result: Promise<RefineResult>; cancel: () => void } {
    clearTimeout(this.idleTimer);
    let id = -1;
    let cancelled = false;
    const result = (async () => {
      const opencv = await this.ensure();
      if (!opencv || !this.worker) throw new Error("画像認識（OpenCV）を読み込めませんでした");
      if (cancelled) throw new Error("中止しました");
      id = this.nextId++;
      if (onInfo) this.infoListeners.set(id, onInfo);
      try {
        return await new Promise<RefineResult>((resolve, reject) => {
          this.jobs.set(id, { resolve, reject, progress });
          this.worker!.postMessage({ type: "video-refine", id, file, input, target: target ? Array.from(target) : null, options } satisfies ToWorker);
        });
      } finally {
        this.infoListeners.delete(id);
      }
    })();
    const cancel = () => {
      cancelled = true;
      if (id >= 0) this.worker?.postMessage({ type: "video-cancel", id } satisfies ToWorker);
    };
    return { result, cancel };
  }

  // ---- ソルブ中から進める解析 ----

  private partialListeners = new Map<number, (p: StreamPartial) => void>();

  // 解析を始める（録画の増えた分は feed で渡す）。onPartial に途中結果が届く
  async startStream(onPartial: (p: StreamPartial) => void): Promise<number | null> {
    clearTimeout(this.idleTimer);
    const opencv = await this.ensure();
    if (!opencv || !this.worker) return null;
    const id = this.nextId++;
    this.partialListeners.set(id, onPartial);
    return id;
  }

  // inspection: インスペクションから始める解析（最初の feed で渡す。solving が届くまでのフレームは間引く: vision.worker.ts の INSPECT_*）
  feed(id: number, recording: Recording, input?: RefineInput, inspection?: boolean): void {
    this.worker?.postMessage({ type: "stream-feed", id, input, recording, inspection } satisfies ToWorker);
  }

  // 回し始めた: 時刻 from から後のフレームは全部処理させる
  solving(id: number, from: number): void {
    this.worker?.postMessage({ type: "stream-solving", id, from } satisfies ToWorker);
  }

  // 終わりの時刻と状態（完成なら solved）を渡し、全体の結果をもらう
  endStream(id: number, to: number, target: ArrayLike<number> | null, progress?: (p: number) => void): Promise<RefineResult> {
    this.partialListeners.delete(id);
    return new Promise((resolve, reject) => {
      if (!this.worker) return reject(new Error("解析の Worker がありません"));
      this.jobs.set(id, { resolve, reject, progress });
      this.worker.postMessage({ type: "stream-end", id, to, target: target ? Array.from(target) : null } satisfies ToWorker);
    });
  }

  cancelStream(id: number): void {
    this.partialListeners.delete(id);
    this.worker?.postMessage({ type: "stream-cancel", id } satisfies ToWorker);
  }

  // 解析が何も残っていなければ Worker を閉じる（OpenCV のヒープ 130MB ほどと解析で使ったメモリを返す。次の解析で作り直す）
  closeIfIdle(): void {
    if (!this.jobs.size && !this.partialListeners.size) this.close();
  }

  close(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
