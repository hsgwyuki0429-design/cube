// 色付き ArUco ステッカーの合成画像（テスト用）。マーカーの白いセルをステッカーの色に置き換え、
// 外側に辺の 8% の色の余白を付ける（印刷した PDF と同じ）。動きのぼけは位置をずらした描画の平均で作る。
import type { CV } from "../src/vision/image";

export interface RenderMarker {
  id: number;
  rgb: [number, number, number];
  cx: number; // ステッカーの中心（px）
  cy: number;
  size: number; // ステッカーの辺（px、余白を含む）
  angle?: number; // 度（時計回り）
  dx?: number; // 露光中の移動（px）
  dy?: number;
}

export interface RenderOptions {
  width: number;
  height: number;
  background: [number, number, number];
  black?: [number, number, number];
  light?: number; // 明るさの倍率
  noise?: number; // 画素ごとの雑音（標準偏差）
  seed?: number;
}

const bitsCache = new Map<number, Uint8Array>();
function bitsOf(cv: CV, id: number): Uint8Array {
  let b = bitsCache.get(id);
  if (!b) {
    const d = cv.getPredefinedDictionary(cv.DICT_4X4_100);
    const m = new cv.Mat();
    cv.generateImageMarker(d, id, 6, m, 1);
    b = new Uint8Array(m.data);
    m.delete();
    d.delete();
    bitsCache.set(id, b);
  }
  return b;
}

export function renderStickers(cv: CV, markers: RenderMarker[], opt: RenderOptions): { data: Uint8ClampedArray; width: number; height: number } {
  const { width: w, height: h } = opt;
  const black = opt.black ?? [28, 28, 30];
  const acc = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) acc.set(opt.background, i * 3);
  for (const m of markers) {
    const bits = bitsOf(cv, m.id);
    const a = ((m.angle ?? 0) * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const steps = m.dx || m.dy ? 9 : 1;
    const reach = (m.size / 2) * Math.SQRT2 + Math.hypot(m.dx ?? 0, m.dy ?? 0) / 2 + 2;
    const x0 = Math.max(0, Math.floor(m.cx - reach));
    const x1 = Math.min(w - 1, Math.ceil(m.cx + reach));
    const y0 = Math.max(0, Math.floor(m.cy - reach));
    const y1 = Math.min(h - 1, Math.ceil(m.cy + reach));
    const margin = m.size * 0.08;
    const cell = (m.size - 2 * margin) / 6;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // 3×3 のサブピクセル × 露光中の位置
        let r = 0;
        let g = 0;
        let b = 0;
        let cover = 0;
        const total = 9 * steps;
        for (let s = 0; s < steps; s++) {
          const f = steps > 1 ? s / (steps - 1) - 0.5 : 0;
          const ox = m.cx + (m.dx ?? 0) * f;
          const oy = m.cy + (m.dy ?? 0) * f;
          for (let sy = 0; sy < 3; sy++) {
            for (let sx = 0; sx < 3; sx++) {
              const px = x + (sx + 0.5) / 3 - 0.5 - ox;
              const py = y + (sy + 0.5) / 3 - 0.5 - oy;
              // ステッカーの座標（左上が 0、上 = マーカーの上辺）
              const u = ca * px + sa * py + m.size / 2;
              const v = -sa * px + ca * py + m.size / 2;
              if (u < 0 || v < 0 || u >= m.size || v >= m.size) continue;
              const cu = Math.floor((u - margin) / cell);
              const cv_ = Math.floor((v - margin) / cell);
              const inMarker = cu >= 0 && cv_ >= 0 && cu < 6 && cv_ < 6;
              const col = inMarker && bits[cv_ * 6 + cu] < 128 ? black : m.rgb;
              r += col[0];
              g += col[1];
              b += col[2];
              cover++;
            }
          }
        }
        if (!cover) continue;
        const k = cover / total;
        const i = (y * w + x) * 3;
        acc[i] = acc[i] * (1 - k) + r / total;
        acc[i + 1] = acc[i + 1] * (1 - k) + g / total;
        acc[i + 2] = acc[i + 2] * (1 - k) + b / total;
      }
    }
  }
  let seed = opt.seed ?? 1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const light = opt.light ?? 1;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = acc[i * 3 + c] * light + (opt.noise ? gauss() * opt.noise : 0);
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}
