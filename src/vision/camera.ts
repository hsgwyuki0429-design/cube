/**
 * カメラ取得とフレームループ。
 *
 * - 背面カメラ / frameRate: { ideal: 120 } を要求する
 * - **要求値と実測値は違う**ので、実測 fps を必ず出す
 * - フレーム取得は video.requestVideoFrameCallback（rAF ではない）
 */

export interface CameraOptions {
  idealWidth?: number;
  idealHeight?: number;
  idealFps?: number;
  facingMode?: 'environment' | 'user';
  deviceId?: string;
}

export interface CameraStats {
  /** rVFC が実際に呼ばれた回数から算出（= 我々が触れるフレーム数） */
  callbackFps: number;
  /** presentedFrames の増分から算出（= カメラが実際に出しているフレーム数） */
  presentedFps: number;
  /** ブラウザが折衝した値（要求値ではない） */
  negotiatedFps: number | null;
  requestedFps: number;
  width: number;
  height: number;
  /** rVFC が使えたか。false なら rAF フォールバック（実測 fps の意味が変わる） */
  usingVideoFrameCallback: boolean;
  droppedFrames: number;
  label: string;
}

const WINDOW_MS = 1000;

export class Camera {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private handle: number | null = null;
  private rafHandle: number | null = null;
  private running = false;
  private cb: ((nowMs: number, meta: VideoFrameCallbackMetadata | null) => void) | null = null;

  private cbTimes: number[] = [];
  private lastPresented = -1;
  private lastPresentedAt = 0;
  private presentedFps = 0;
  private droppedFrames = 0;
  private requestedFps = 0;
  private usingRvfc = false;

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
  }

  async start(opts: CameraOptions = {}): Promise<void> {
    const idealFps = opts.idealFps ?? 120;
    this.requestedFps = idealFps;
    const video: MediaTrackConstraints = {
      width: { ideal: opts.idealWidth ?? 1280 },
      height: { ideal: opts.idealHeight ?? 720 },
      frameRate: { ideal: idealFps },
    };
    if (opts.deviceId) video.deviceId = { exact: opts.deviceId };
    else video.facingMode = { ideal: opts.facingMode ?? 'environment' };

    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.track = this.stream.getVideoTracks()[0] ?? null;
    this.video.srcObject = this.stream;
    await this.video.play();
    await new Promise<void>((resolve) => {
      if (this.video.readyState >= 2) resolve();
      else this.video.addEventListener('loadeddata', () => resolve(), { once: true });
    });
    this.usingRvfc = typeof this.video.requestVideoFrameCallback === 'function';
  }

  /** 利用可能なカメラ一覧（許可後のみラベルが取れる）。 */
  static async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  onFrame(cb: (nowMs: number, meta: VideoFrameCallbackMetadata | null) => void): void {
    this.cb = cb;
  }

  startLoop(): void {
    if (this.running) return;
    this.running = true;
    this.cbTimes.length = 0;
    this.lastPresented = -1;
    if (this.usingRvfc) this.scheduleRvfc();
    else this.scheduleRaf();
  }

  stopLoop(): void {
    this.running = false;
    if (this.handle !== null && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.handle);
      this.handle = null;
    }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  stop(): void {
    this.stopLoop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
  }

  private scheduleRvfc(): void {
    this.handle = this.video.requestVideoFrameCallback((now, meta) => {
      if (!this.running) return;
      this.tick(now, meta);
      this.scheduleRvfc();
    });
  }

  private scheduleRaf(): void {
    this.rafHandle = requestAnimationFrame((now) => {
      if (!this.running) return;
      this.tick(now, null);
      this.scheduleRaf();
    });
  }

  private tick(now: number, meta: VideoFrameCallbackMetadata | null): void {
    const wall = performance.now();
    this.cbTimes.push(wall);
    while (this.cbTimes.length > 2 && wall - this.cbTimes[0] > WINDOW_MS) this.cbTimes.shift();

    if (meta) {
      if (this.lastPresented >= 0) {
        const dFrames = meta.presentedFrames - this.lastPresented;
        const dt = wall - this.lastPresentedAt;
        if (dt > 0) {
          const inst = (dFrames * 1000) / dt;
          // 指数移動平均で滑らかにする（瞬時値は暴れる）
          this.presentedFps = this.presentedFps === 0 ? inst : this.presentedFps * 0.9 + inst * 0.1;
        }
        if (dFrames > 1) this.droppedFrames += dFrames - 1;
      }
      this.lastPresented = meta.presentedFrames;
      this.lastPresentedAt = wall;
    }
    this.cb?.(now, meta);
  }

  stats(): CameraStats {
    const n = this.cbTimes.length;
    let callbackFps = 0;
    if (n >= 2) {
      const span = this.cbTimes[n - 1] - this.cbTimes[0];
      if (span > 0) callbackFps = ((n - 1) * 1000) / span;
    }
    const settings = this.track?.getSettings?.() ?? {};
    return {
      callbackFps,
      presentedFps: this.presentedFps,
      negotiatedFps: typeof settings.frameRate === 'number' ? settings.frameRate : null,
      requestedFps: this.requestedFps,
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      usingVideoFrameCallback: this.usingRvfc,
      droppedFrames: this.droppedFrames,
      label: this.track?.label ?? '',
    };
  }

  get ready(): boolean {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }
}
