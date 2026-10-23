// 面の各セルの色を、セル中央部の多数の点から頑健に求める。
// 実物のステッカーは艶があり、照明の映り込み（白く飛んだ点）が乗る。人の目は映り込みを無視して下地の色を見るので、
// ここでも「周りより明るく、色が薄い点」（映り込み）と「暗い点」（隙間・影・指の縁）を除いてから中央値を取る。
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
  spread: number; // 点ごとのばらつき（大きい = 境界・指がかかっている。映り込みは除いた後）
  valid: boolean;
  glare: number; // 映り込みとして除いた点の割合
  clip: number; // 白く飛んだ点の割合（大きいと、白・黄・映り込みの区別がつかない）
}

const GRID = 7;

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

// 白く飛んだ点（露出オーバーで色の情報が失われている）
const clipped = (r: number, g: number, b: number) => Math.min(r, g, b) >= 238;

function collect(img: PixelSource, face: { H: Mat3; rot: number }, cx: number, cy: number, region: number, grid: number, R: number[], G: number[], B: number[]): number {
  const half = region / 2;
  let outside = 0;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const x = cx - half + (region * (j + 0.5)) / grid;
      const y = cy - half + (region * (i + 0.5)) / grid;
      const [px, py] = slotPoint(face, x, y);
      const ix = Math.round(px);
      const iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= img.width || iy >= img.height || !Number.isFinite(px)) {
        outside++;
        continue;
      }
      const k = (iy * img.width + ix) * 4;
      R.push(img.data[k]);
      G.push(img.data[k + 1]);
      B.push(img.data[k + 2]);
    }
  }
  return outside;
}

export function sampleFace(img: PixelSource, face: { H: Mat3; rot: number }, region = 0.6): CellSample[] {
  const out: CellSample[] = [];
  const R: number[] = [];
  const G: number[] = [];
  const B: number[] = [];
  for (let cell = 0; cell < 9; cell++) {
    const cx = (cell % 3) + 0.5;
    const cy = Math.floor(cell / 3) + 0.5;
    R.length = G.length = B.length = 0;
    const outside = collect(img, face, cx, cy, region, GRID, R, G, B);
    const n = R.length;
    if (n < 8) {
      out.push({ lab: [0, 0, 0], spread: Infinity, valid: false, glare: 0, clip: 0 });
      continue;
    }
    const V = R.map((r, i) => Math.max(r, G[i], B[i]));
    const S = R.map((r, i) => (V[i] - Math.min(r, G[i], B[i])) / (V[i] + 1));
    const medV = median(V);
    const medS = median(S);
    let keep: number[] = [];
    let glare = 0;
    for (let i = 0; i < n; i++) {
      // 映り込み: 周りより明るく、色が薄い（白いステッカーなら中央値も薄いので除かれない）
      const isGlare = V[i] > Math.min(250, medV + 28) && S[i] < medS * 0.55 + 0.04;
      // 飛んだ点: 色のあるステッカーで真っ白に近い
      const blown = medS > 0.25 && R[i] > 240 && G[i] > 240 && B[i] > 240;
      if (isGlare || blown) {
        glare++;
        continue;
      }
      if (V[i] < medV * 0.55) continue; // 隙間・影
      keep.push(i);
    }
    if (keep.length < Math.max(6, n * 0.3)) keep = Array.from({ length: n }, (_, i) => i);
    const rs = keep.map((i) => R[i]).sort((a, b) => a - b);
    const gs = keep.map((i) => G[i]).sort((a, b) => a - b);
    const bs = keep.map((i) => B[i]).sort((a, b) => a - b);
    const m = rs.length >> 1;
    let lab = rgbToLab(rs[m], gs[m], bs[m]);
    // 中央が白く飛んでいる（明るい黄色と白が同じ値になる）: 光が弱まるステッカーの縁の、飛んでいない点から色味を取る。
    // 人の目もそこを見てクリーム色（黄）と白を見分けている
    const nClipped = keep.filter((i) => clipped(R[i], G[i], B[i])).length;
    if (nClipped > keep.length * 0.35) {
      const r2: number[] = [];
      const g2: number[] = [];
      const b2: number[] = [];
      collect(img, face, cx, cy, 0.88, 11, r2, g2, b2);
      const lit: number[] = [];
      for (let i = 0; i < r2.length; i++) {
        const v = Math.max(r2[i], g2[i], b2[i]);
        if (!clipped(r2[i], g2[i], b2[i]) && v > medV * 0.6) lit.push(i);
      }
      if (lit.length >= 6) {
        const mr = median(lit.map((i) => r2[i]));
        const mg = median(lit.map((i) => g2[i]));
        const mb = median(lit.map((i) => b2[i]));
        const edge = rgbToLab(mr, mg, mb);
        // 明るさは飛んだ中央のもの（白と黄を明るさの差で分けないように）、色味は縁のもの
        lab = [lab[0], edge[1], edge[2]];
      }
    }
    // 四分位範囲の最大値をばらつきとする
    const q1 = rs.length >> 2;
    const q3 = Math.min(rs.length - 1, (3 * rs.length) >> 2);
    const spread = Math.max(rs[q3] - rs[q1], gs[q3] - gs[q1], bs[q3] - bs[q1]);
    let nClip = 0;
    for (let i = 0; i < n; i++) if (clipped(R[i], G[i], B[i])) nClip++;
    out.push({ lab, spread, valid: outside < GRID * GRID * 0.3, glare: glare / n, clip: nClip / n });
  }
  return out;
}
