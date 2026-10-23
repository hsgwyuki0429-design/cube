// 手の検出クライアント。21点の凸包を少し膨らませた多角形（正規化座標）を返す。
import type { Pt } from "./homography";

// Worker 内の相対 URL は Worker のスクリプトの場所から解決されるので、ページ基準の絶対 URL にして渡す
const pageUrl = (path: string) => new URL(`${import.meta.env.BASE_URL}${path}`, document.baseURI).href;
const MODEL_URLS = () => [pageUrl("mediapipe/hand_landmarker.task"), "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"];

export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// 指は関節点より太いので、重心から外へ margin（正規化座標）だけ広げる
function grow(poly: Pt[], margin: number): Pt[] {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / d) * margin, y + ((y - cy) / d) * margin] as Pt;
  });
}

export class HandsClient {
  private worker: Worker | null = null;
  private busy = false;
  hulls: Pt[][] = [];
  landmarks: Pt[][] = [];
  status: "off" | "loading" | "ready" | "error" = "off";
  error: string | null = null;
  delegate = "";
  onUpdate: ((hulls: Pt[][]) => void) | null = null;

  start(): void {
    if (this.worker) return;
    this.status = "loading";
    this.worker = new Worker(new URL("./hands.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") {
        this.status = "ready";
        this.delegate = m.delegate;
      } else if (m.type === "error") {
        this.status = "error";
        this.error = m.message;
      } else if (m.type === "hands") {
        this.busy = false;
        this.landmarks = m.hands;
        this.hulls = (m.hands as Pt[][]).map((h) => grow(convexHull(h), 0.025));
        this.onUpdate?.(this.hulls);
      }
    };
    this.worker.postMessage({ type: "init", wasmBase: pageUrl("mediapipe/wasm"), modelUrls: MODEL_URLS() });
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.status = "off";
    this.hulls = [];
    this.landmarks = [];
    this.busy = false;
    this.onUpdate?.([]);
  }

  private lastSubmit = 0;

  // 15Hz まで（手の位置は数フレームに1回で十分。遅い端末で認識処理の CPU を奪わないように）
  async submit(video: HTMLVideoElement, t: number): Promise<void> {
    if (this.status !== "ready" || this.busy || !video.videoWidth || !this.worker || t - this.lastSubmit < 66) return;
    this.lastSubmit = t;
    this.busy = true;
    try {
      const w = 320;
      const h = Math.round((video.videoHeight * w) / video.videoWidth);
      const bitmap = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h });
      this.worker.postMessage({ type: "frame", bitmap, t }, [bitmap]);
    } catch {
      this.busy = false;
    }
  }
}
