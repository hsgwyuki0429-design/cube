// 面の各セル中央部を複数点サンプリングして Lab を得る（エッジやステッカーの隙間を拾わないよう中央50%のみ）。
import { type Lab, rgbToLab } from "./color";
import type { Mat3 } from "./homography";
import { slotPoint } from "./layout";

export interface PixelSource {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface CellSample {
  lab: Lab;
  spread: number; // 点ごとのばらつき（大きい = 境界・反射・指がかかっている）
  valid: boolean;
}

const GRID = 5;

export function sampleFace(img: PixelSource, face: { H: Mat3; rot: number }, region = 0.5): CellSample[] {
  const out: CellSample[] = [];
  const r = new Array<number>(GRID * GRID);
  const g = new Array<number>(GRID * GRID);
  const b = new Array<number>(GRID * GRID);
  const half = region / 2;
  for (let cell = 0; cell < 9; cell++) {
    const cx = (cell % 3) + 0.5;
    const cy = Math.floor(cell / 3) + 0.5;
    let n = 0;
    let outside = 0;
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        const x = cx - half + (region * (j + 0.5)) / GRID;
        const y = cy - half + (region * (i + 0.5)) / GRID;
        const [px, py] = slotPoint(face, x, y);
        const ix = Math.round(px);
        const iy = Math.round(py);
        if (ix < 0 || iy < 0 || ix >= img.width || iy >= img.height || !Number.isFinite(px)) {
          outside++;
          continue;
        }
        const k = (iy * img.width + ix) * 4;
        r[n] = img.data[k];
        g[n] = img.data[k + 1];
        b[n] = img.data[k + 2];
        n++;
      }
    }
    if (n < 5) {
      out.push({ lab: [0, 0, 0], spread: Infinity, valid: false });
      continue;
    }
    const rs = r.slice(0, n).sort((p, q) => p - q);
    const gs = g.slice(0, n).sort((p, q) => p - q);
    const bs = b.slice(0, n).sort((p, q) => p - q);
    const m = n >> 1;
    const lab = rgbToLab(rs[m], gs[m], bs[m]);
    // 四分位範囲の最大値をばらつきとする
    const q1 = n >> 2;
    const q3 = Math.min(n - 1, (3 * n) >> 2);
    const spread = Math.max(rs[q3] - rs[q1], gs[q3] - gs[q1], bs[q3] - bs[q1]);
    out.push({ lab, spread, valid: outside < GRID * GRID * 0.3 });
  }
  return out;
}
