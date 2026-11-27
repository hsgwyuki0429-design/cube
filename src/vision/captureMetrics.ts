// 撮り方の物差し（撮り方の案内: src/app/captureAdvice.ts）。1 フレームの見え方（SightFrame）から、キューブの大きさ・位置・見えている面の数・
// 正面の面の傾きを、画素からキューブの周りの明るさを測る。DOM もカメラも知らない（Worker と Node の調べる道具で同じものを使う）
import type { PixelSource } from "./image";
import type { SightFrame } from "../track/sight";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ViewMetrics {
  faces: number; // 組み立てられた面（1 列・1 枚の面は数えない）
  faceEdge: number; // いちばん大きく写った面の辺（画素。4 辺の平均）
  box: Box | null; // 見えている面を全部囲む箱（画素）
  cx: number; // 箱の真ん中（画面の幅・高さに対する割合。真ん中 = 0、端 = ±0.5）
  cy: number;
  edge: boolean; // 箱が画面の端にかかっている（キューブの一部が画面の外）
  frontCos: number; // いちばん正面を向いた面の、縮んで見える割合（短い方の向きの長さ ÷ 長い方。1 = 正面、0 = 真横）
}

const dist = (q: number[], a: number, b: number) => Math.hypot(q[2 * a] - q[2 * b], q[2 * a + 1] - q[2 * b + 1]);

export function viewMetrics(sight: SightFrame | undefined, width: number, height: number): ViewMetrics {
  const empty: ViewMetrics = { faces: 0, faceEdge: 0, box: null, cx: 0, cy: 0, edge: false, frontCos: 0 };
  if (!sight?.faces.length) return empty;
  let faces = 0;
  let faceEdge = 0;
  let frontCos = 0;
  let best = -1;
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const f of sight.faces) {
    const q = f.quad;
    if (!q || q.length < 8) continue;
    for (let i = 0; i < 4; i++) {
      box.x0 = Math.min(box.x0, q[2 * i]);
      box.x1 = Math.max(box.x1, q[2 * i]);
      box.y0 = Math.min(box.y0, q[2 * i + 1]);
      box.y1 = Math.max(box.y1, q[2 * i + 1]);
    }
    if (f.held) continue;
    faces++;
    const e = (dist(q, 0, 1) + dist(q, 1, 2) + dist(q, 2, 3) + dist(q, 3, 0)) / 4;
    // 縮み: 向かい合う辺の真ん中どうしを結ぶ 2 本の長さの比
    const mx = Math.hypot((q[2] + q[4] - q[0] - q[6]) / 2, (q[3] + q[5] - q[1] - q[7]) / 2);
    const my = Math.hypot((q[6] + q[4] - q[0] - q[2]) / 2, (q[7] + q[5] - q[1] - q[3]) / 2);
    const c = Math.min(mx, my) / Math.max(1e-6, Math.max(mx, my));
    if (e > faceEdge) faceEdge = e;
    // いちばん正面を向いた面 = 見かけの面積のいちばん大きい面
    const area = mx * my;
    if (area > best) {
      best = area;
      frontCos = c;
    }
  }
  if (!Number.isFinite(box.x0)) return empty;
  const m = 0.01 * Math.max(width, height);
  return {
    faces,
    faceEdge,
    box,
    cx: (box.x0 + box.x1) / 2 / width - 0.5,
    cy: (box.y0 + box.y1) / 2 / height - 0.5,
    edge: box.x0 < m || box.y0 < m || box.x1 > width - m || box.y1 > height - m,
    frontCos,
  };
}

// キューブの周り（box を 1 辺の 15% 広げた所）と画面全体の明るさ（max(R, G, B) の平均、0〜255）。粗く間引いて測る（1 回 1ms もかからない）
export function brightness(img: PixelSource, box: Box | null, samples = 48): { cube: number; frame: number } {
  const { width: w, height: h, data } = img;
  const at = (x: number, y: number) => {
    const i = (Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))) * 4;
    return Math.max(data[i], data[i + 1], data[i + 2]);
  };
  const mean = (x0: number, y0: number, x1: number, y1: number) => {
    let s = 0;
    let n = 0;
    for (let j = 0; j < samples; j++)
      for (let i = 0; i < samples; i++) {
        s += at(x0 + ((i + 0.5) / samples) * (x1 - x0), y0 + ((j + 0.5) / samples) * (y1 - y0));
        n++;
      }
    return n ? s / n : 0;
  };
  const frame = mean(0, 0, w, h);
  if (!box) return { cube: frame, frame };
  const px = (box.x1 - box.x0) * 0.15;
  const py = (box.y1 - box.y0) * 0.15;
  return { cube: mean(box.x0 - px, box.y0 - py, box.x1 + px, box.y1 + py), frame };
}
