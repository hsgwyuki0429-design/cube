// 認識 Worker のクライアント。空いているときだけ最新フレームを送る（詰まったら間引く）。
import type { EngineOptions } from "../track/engine";
import type { Lab } from "./color";
import type { Pt } from "./homography";
import type { PipelineConfig } from "./pipeline";
import type { FrameMessage, FromWorker, ToWorker } from "./protocol";

export class VisionClient {
  private worker: Worker;
  private busy = false;
  private nextId = 1;
  private listeners = new Set<(m: FrameMessage) => void>();
  private procTimes: number[] = [];
  private fallbackCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
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
      const w = Math.min(this.workWidth, video.videoWidth);
      const h = Math.round((video.videoHeight * w) / video.videoWidth);
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
}
