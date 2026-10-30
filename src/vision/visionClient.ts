// 認識 Worker のクライアント。空いているときだけ最新フレームを送る（詰まったら間引く）。
import type { EngineOptions, TrackUpdate } from "../track/engine";
import type { DecodedMove } from "../track/types";
import type { Lab } from "./color";
import type { Pt } from "./homography";
import type { PipelineConfig } from "./pipeline";
import type { FrameMessage, FromWorker, StreamPartial, ToWorker, VideoRefineOptions } from "./protocol";
import type { Recording } from "./recorder";
import type { HandSample, RefineInput, RefineResult } from "./refine";
import type { VideoFileInfo } from "./videoFile";

export class VisionClient {
  private worker: Worker;
  private busy = false;
  private nextId = 1;
  private listeners = new Set<(m: FrameMessage) => void>();
  private procTimes: number[] = [];
  private fallbackCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private queries = new Map<number, (t: TrackUpdate | null) => void>();
  readonly ready: Promise<{ opencv: boolean; ms: number }>;
  isReady = false;
  opencv = false;
  workWidth = 800;
  procFps = 0;
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
          this.busy = false;
        } else if (m.type === "frame") {
          this.busy = false;
          this.lastProcMs = m.procMs;
          const now = performance.now();
          this.procTimes.push(now);
          while (this.procTimes.length && now - this.procTimes[0] > 1000) this.procTimes.shift();
          this.procFps = this.procTimes.length;
          for (const l of this.listeners) l(m);
        } else if (m.type === "track-snapshot") {
          this.queries.get(m.id)?.(m.track);
          this.queries.delete(m.id);
        }
      };
      this.worker.onerror = (e) => {
        this.lastError = e.message;
        if (!this.isReady) reject(new Error(e.message));
      };
    });
    this.post({ type: "init" });
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  onResult(cb: (m: FrameMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async submit(video: HTMLVideoElement, t: number): Promise<boolean> {
    if (!this.isReady || this.busy || !video.videoWidth) return false;
    this.busy = true;
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
      this.post({ type: "frame", id: this.nextId++, t, bitmap }, [bitmap]);
      return true;
    } catch (e) {
      this.busy = false;
      this.lastError = String(e);
      return false;
    }
  }

  setConfig(config: Partial<PipelineConfig>): void {
    this.post({ type: "config", config });
  }

  setHands(hands: Pt[][]): void {
    this.post({ type: "hands", hands });
  }

  setRefs(refs: Lab[] | null): void {
    this.post({ type: "refs", refs });
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

  // 精密解析が解き直した結果に乗り換える（t より後の観測は Worker の中でもう一度通す）
  rebase(state: ArrayLike<number>, orient: number, moves: DecodedMove[], t: number, keep: number): void {
    this.post({ type: "track-rebase", state: Array.from(state), orient, moves, t, keep });
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
        else if (m.type === "refine-progress") this.jobs.get(m.id)?.progress?.(m.done / Math.max(1, m.total));
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
    worker.postMessage({ type: "init" } satisfies ToWorker);
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

  feed(id: number, recording: Recording, hands: HandSample[], input?: RefineInput): void {
    this.worker?.postMessage({ type: "stream-feed", id, input, recording, hands } satisfies ToWorker);
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

  // フリーで完成した: 時刻 t までを、終わりを target として前後から解き直させる（結果は途中結果として届く）
  anchorStream(id: number, t: number, target: ArrayLike<number>): void {
    this.worker?.postMessage({ type: "stream-anchor", id, t, target: Array.from(target) } satisfies ToWorker);
  }

  cancelStream(id: number): void {
    this.partialListeners.delete(id);
    this.worker?.postMessage({ type: "stream-cancel", id } satisfies ToWorker);
  }

  close(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
