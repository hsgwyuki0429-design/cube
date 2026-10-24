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

// 手の 21 点（MediaPipe の並び）から、手が覆う範囲の多角形の集まりを作る（正規化座標）。
// 点は関節の中心なので、指は点より太い。指の骨ごとに、手のひらの長さに比例した半径で太らせた「カプセル」と、
// 手のひらの多角形にする。以前は凸包を一定の幅（画面幅の 2.5%）だけ広げていたが、カメラに近い手では指の縁が
// はみ出して、親指が白いステッカーと読まれていた。カプセルなら指の間に見えるステッカーは隠さない
const BONES: [number, number][] = [
  [1, 2], [2, 3], [3, 4], // 親指
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
];
const PALM = [0, 1, 2, 5, 9, 13, 17];
const FINGER_RADIUS = 0.16; // 手のひらの長さ（手首〜中指の付け根）に対する指の半径（指の幅 ≈ 手のひらの長さの 0.2 + 余裕）

// aspect: 画像の幅 / 高さ（正規化座標は x と y で縮尺が違う）
export function handMasks(points: Pt[], aspect: number): Pt[][] {
  if (points.length < 21) return points.length >= 3 ? [convexHull(points)] : [];
  // 縦横の縮尺をそろえた座標（x を aspect 倍）で計算して戻す
  const P = points.map(([x, y]) => [x * aspect, y] as Pt);
  const back = (p: Pt): Pt => [p[0] / aspect, p[1]];
  const palmLen = Math.hypot(P[9][0] - P[0][0], P[9][1] - P[0][1]);
  const r = Math.max(1e-3, palmLen * FINGER_RADIUS);
  const out: Pt[][] = [];
  for (const [a, b] of BONES) {
    const [ax, ay] = P[a];
    const [bx, by] = P[b];
    const d = Math.hypot(bx - ax, by - ay) || 1e-6;
    const nx = (-(by - ay) / d) * r;
    const ny = ((bx - ax) / d) * r;
    const ux = ((bx - ax) / d) * r;
    const uy = ((by - ay) / d) * r;
    // 両端を半径分だけ伸ばした細長い六角形（丸い端の近似）
    out.push(
      [
        [ax - ux, ay - uy],
        [ax + nx, ay + ny],
        [bx + nx, by + ny],
        [bx + ux, by + uy],
        [bx - nx, by - ny],
        [ax - nx, ay - ny],
      ].map((p) => back(p as Pt)),
    );
  }
  // 手のひら: 付け根の点の凸包を半径分だけ広げる
  const palm = convexHull(PALM.map((i) => P[i]));
  const cx = palm.reduce((s, p) => s + p[0], 0) / palm.length;
  const cy = palm.reduce((s, p) => s + p[1], 0) / palm.length;
  out.push(
    palm.map(([x, y]) => {
      const d = Math.hypot(x - cx, y - cy) || 1;
      return back([x + ((x - cx) / d) * r, y + ((y - cy) / d) * r]);
    }),
  );
  return out;
}

export class HandsClient {
  private worker: Worker | null = null;
  private busy = false;
  private pendingT = 0;
  hulls: Pt[][] = [];
  // 検出結果の履歴（フレームの時刻つき）。ソルブ後の精密解析で、各フレームの手を隠すのに使う
  history: { t: number; hulls: Pt[][] }[] = [];
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
        this.hulls = (m.hands as Pt[][]).flatMap((h) => handMasks(h, this.aspect));
        this.history.push({ t: this.pendingT, hulls: this.hulls });
        while (this.history.length && this.pendingT - this.history[0].t > 150000) this.history.shift();
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
    this.history = [];
    this.busy = false;
    this.onUpdate?.([]);
  }

  private lastSubmit = 0;
  private aspect = 16 / 9;

  // 15Hz まで（手の位置は数フレームに1回で十分。遅い端末で認識処理の CPU を奪わないように）
  historyBetween(t0: number, t1: number): { t: number; hulls: Pt[][] }[] {
    return this.history.filter((h) => h.t >= t0 - 300 && h.t <= t1 + 300);
  }

  async submit(video: HTMLVideoElement, t: number): Promise<void> {
    if (this.status !== "ready" || this.busy || !video.videoWidth || !this.worker || t - this.lastSubmit < 66) return;
    this.lastSubmit = t;
    this.pendingT = t;
    this.busy = true;
    try {
      const w = 320;
      const h = Math.round((video.videoHeight * w) / video.videoWidth);
      this.aspect = video.videoWidth / video.videoHeight;
      const bitmap = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h });
      this.worker.postMessage({ type: "frame", bitmap, t }, [bitmap]);
    } catch {
      this.busy = false;
    }
  }
}
