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

type FrameCallback = (now: number) => void;

export class CameraSource {
  readonly video: HTMLVideoElement;
  stream: MediaStream | null = null;
  info: CameraInfo | null = null;
  fps = 0;
  private callbacks = new Set<FrameCallback>();
  private frameTimes: number[] = [];
  private running = false;
  private handle = 0;

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

  onFrame(cb: FrameCallback): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  private loop(): void {
    const tick = (now: number) => {
      if (!this.running) return;
      this.frameTimes.push(now);
      while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
      this.fps = this.frameTimes.length;
      for (const cb of this.callbacks) cb(now);
      schedule();
    };
    const schedule = () => {
      if ("requestVideoFrameCallback" in this.video) this.handle = this.video.requestVideoFrameCallback((now) => tick(now));
      else requestAnimationFrame((now) => tick(now)); // 古いブラウザ向け
    };
    schedule();
  }
}
