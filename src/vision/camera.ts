// カメラ取得と、フレームごとのコールバック（requestVideoFrameCallback）。実測 fps を数える。
export interface CameraInfo {
  width: number;
  height: number;
  frameRate?: number; // 折衝された値
  label: string;
  deviceId?: string;
  facingMode?: string;
}

export interface CameraRequest {
  deviceId?: string;
  facingMode?: "user" | "environment";
  height?: number; // 720 / 1080
  frameRate?: number;
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
}

export function cameraErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (!window.isSecureContext) return "カメラは HTTPS か localhost でしか使えません。https:// のURLで開いてください。";
  if (name === "NotAllowedError" || name === "SecurityError") return "カメラの使用が許可されていません。ブラウザのアドレスバーからカメラを許可してください。";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "使えるカメラが見つかりませんでした。";
  if (name === "NotReadableError") return "カメラが他のアプリで使用中です。";
  return `カメラを開始できませんでした（${name ?? String(e)}）。`;
}

// t: フレームの時刻（ms、performance.now() の時間軸）。撮影時刻が分かればそれ（表示のタイミングの揺れを含まない）
type FrameCallback = (t: number) => void;

export class CameraSource {
  readonly video: HTMLVideoElement;
  stream: MediaStream | null = null;
  info: CameraInfo | null = null;
  fps = 0;
  private callbacks = new Set<FrameCallback>();
  private endedCallbacks = new Set<() => void>();
  private frameTimes: number[] = [];
  private running = false;
  private handle = 0;
  private captureOffset: number | null = null;
  private lastT = 0;

  constructor(video?: HTMLVideoElement) {
    this.video = video ?? document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
  }

  async start(req: CameraRequest = {}): Promise<CameraInfo> {
    this.stop();
    const height = req.height ?? 720;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(req.deviceId ? { deviceId: { exact: req.deviceId } } : { facingMode: req.facingMode ?? "user" }),
        width: { ideal: Math.round((height * 16) / 9) },
        height: { ideal: height },
        frameRate: { ideal: req.frameRate ?? 60 },
      },
    });
    return this.attach(stream);
  }

  // 合成カメラ（デモ）など任意のストリーム
  async attach(stream: MediaStream): Promise<CameraInfo> {
    this.stop();
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play().catch(() => undefined);
    if (!this.video.videoWidth) await new Promise((r) => this.video.addEventListener("loadedmetadata", r, { once: true }));
    const track = stream.getVideoTracks()[0];
    // 他のアプリがカメラを使い始めた・カメラが外れた・OS が止めたときに、映像が黒いまま止まらないように知らせる
    track?.addEventListener("ended", () => {
      if (this.stream === stream) for (const cb of this.endedCallbacks) cb();
    });
    const s = track?.getSettings?.() ?? {};
    this.info = {
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      frameRate: s.frameRate,
      label: track?.label ?? "",
      deviceId: s.deviceId,
      facingMode: s.facingMode,
    };
    this.running = true;
    this.loop();
    return this.info;
  }

  stop(): void {
    this.running = false;
    if (this.handle && "cancelVideoFrameCallback" in this.video) this.video.cancelVideoFrameCallback(this.handle);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.frameTimes = [];
    this.fps = 0;
  }

  onEnded(cb: () => void): () => void {
    this.endedCallbacks.add(cb);
    return () => this.endedCallbacks.delete(cb);
  }

  onFrame(cb: FrameCallback): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  // 撮影時刻（captureTime）があればそれを使う。表示の時刻（now）は画面の更新に合わせて最大 1 コマ分揺れる。
  // 撮影時刻が来ないフレームは、直前までのずれを引いて同じ時間軸にそろえる
  private frameTime(now: number, meta?: VideoFrameCallbackMetadata): number {
    const cap = (meta as { captureTime?: number } | undefined)?.captureTime;
    let t: number;
    if (cap !== undefined && cap > now - 1000 && cap <= now + 1) {
      this.captureOffset = now - cap;
      t = cap;
    } else t = this.captureOffset !== null ? now - this.captureOffset : now;
    t = Math.max(t, this.lastT + 0.1);
    this.lastT = t;
    return t;
  }

  private loop(): void {
    this.captureOffset = null;
    this.lastT = 0;
    const tick = (now: number, meta?: VideoFrameCallbackMetadata) => {
      if (!this.running) return;
      this.frameTimes.push(now);
      while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
      this.fps = this.frameTimes.length;
      const t = this.frameTime(now, meta);
      for (const cb of this.callbacks) cb(t);
      schedule();
    };
    const schedule = () => {
      if ("requestVideoFrameCallback" in this.video) this.handle = this.video.requestVideoFrameCallback((now, meta) => tick(now, meta));
      else requestAnimationFrame((now) => tick(now)); // 古いブラウザ向け
    };
    schedule();
  }
}
