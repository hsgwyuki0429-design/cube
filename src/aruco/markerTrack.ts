// マーカーを検出せずに追う（ライブ）: 前のフレームで読めたマーカーの近くを少しずつずらして、符号のマス（枠を含む）の明暗が合う位置を探す。
// OpenCV の検出（二値化を何回も繰り返して輪郭を探す）より 1 桁軽い。ずらすだけなので、回している層・持ち替え（傾きが変わる）・
// 指がかかったマーカーは合わずに外れる。外れたマーカーが多ければ検出し直す（src/vision/arucoFrame.ts）。DOM もカメラも知らない
import { type Mat3, type Pt, applyH, fitHomography } from "../vision/homography";
import type { ImageLike, Marker } from "./detect";

export interface TrackOptions {
  minFit: number; // 符号のマスの明暗が合う割合の下限（5×5 のマスなら 1 マスまで違ってよい）
  minContrast: number; // 明るいマスと暗いマスの差の下限（max(R,G,B)、0..255）
  reach: number; // 探す範囲（マーカーの辺に対する割合、片側）
}

export const DEFAULT_TRACK: TrackOptions = { minFit: 0.96, minContrast: 40, reach: 0.3 };

// マーカーの各マス（枠を含む cells × cells）の画像上の位置。sub: マスの中で真ん中から ±0.35 マス（マスの縁の近く）ずらした 3×3 点も
// （位置を詰めるとき）
function moduleCenters(corners: number[], cells: number, sub = false): Pt[] | null {
  const H: Mat3 | null = fitHomography(
    [
      [0, 0],
      [cells, 0],
      [cells, cells],
      [0, cells],
    ],
    [0, 1, 2, 3].map((i) => [corners[i * 2], corners[i * 2 + 1]] as Pt),
  );
  if (!H) return null;
  const out: Pt[] = [];
  const offs = sub ? [-0.35, 0, 0.35] : [0];
  for (let r = 0; r < cells; r++) for (let c = 0; c < cells; c++) for (const dy of offs) for (const dx of offs) out.push(applyH(H, c + 0.5 + dx, r + 0.5 + dy));
  return out;
}

// 点の画素（四捨五入）を先に求めておく。ずらす量は整数なので、ずらした点の画素は丸めた画素を同じだけずらしたもの
// （Math.round(x + n) = Math.round(x) + n）。範囲の判定も、点の画素の範囲をずらして 1 回で済む
interface Probe {
  base: Int32Array; // 画素の番号（y * 幅 + x）
  light: Uint8Array; // 符号で明るいはずの点か
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  v: Float32Array; // 読んだ明るさ（使い回す）
}

function probeOf(img: ImageLike, pts: Pt[], bits: Uint8Array, per: number): Probe {
  const n = pts.length;
  const base = new Int32Array(n);
  const light = new Uint8Array(n);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < n; k++) {
    const xi = Math.round(pts[k][0]);
    const yi = Math.round(pts[k][1]);
    base[k] = yi * img.width + xi;
    light[k] = bits[Math.floor(k / per)] ? 1 : 0;
    if (xi < x0) x0 = xi;
    if (xi > x1) x1 = xi;
    if (yi < y0) y0 = yi;
    if (yi > y1) y1 = yi;
  }
  return { base, light, x0, x1, y0, y1, v: new Float32Array(n) };
}

const inside = (img: ImageLike, p: Probe, dx: number, dy: number) => p.x0 + dx >= 0 && p.y0 + dy >= 0 && p.x1 + dx < img.width && p.y1 + dy < img.height;

// (dx, dy) ずらしたときの、符号どおりの明暗の割合と明暗の差
function score(img: ImageLike, p: Probe, dx: number, dy: number): { fit: number; contrast: number } {
  if (!inside(img, p, dx, dy)) return { fit: 0, contrast: 0 };
  const d = img.data;
  const off = dy * img.width + dx;
  const v = p.v;
  const n = v.length;
  let sl = 0;
  let sd = 0;
  let nl = 0;
  let nd = 0;
  for (let k = 0; k < n; k++) {
    const i = (p.base[k] + off) * 4;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const m = r > g ? (r > b ? r : b) : g > b ? g : b;
    v[k] = m;
    if (p.light[k]) {
      sl += m;
      nl++;
    } else {
      sd += m;
      nd++;
    }
  }
  const L = sl / Math.max(1, nl);
  const D = sd / Math.max(1, nd);
  const mid = (L + D) / 2;
  let ok = 0;
  for (let k = 0; k < n; k++) if (v[k] > mid === p.light[k] > 0) ok++;
  return { fit: ok / n, contrast: L - D };
}

// 符号の明暗との相関（明るいはずの点の明るさ − 暗いはずの点の明るさ の平均）。マスの縁の近くの点も使うので、位置が合うほど大きい
// （明暗が合う割合はマスの真ん中が入っていれば 1 になり、数画素ずれても変わらなかった）
function correlation(img: ImageLike, p: Probe, dx: number, dy: number): number {
  if (!inside(img, p, dx, dy)) return -Infinity;
  const d = img.data;
  const off = dy * img.width + dx;
  const n = p.base.length;
  let sl = 0;
  let sd = 0;
  let nl = 0;
  let nd = 0;
  for (let k = 0; k < n; k++) {
    const i = (p.base[k] + off) * 4;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const m = r > g ? (r > b ? r : b) : g > b ? g : b;
    if (p.light[k]) {
      sl += m;
      nl++;
    } else {
      sd += m;
      nd++;
    }
  }
  return sl / Math.max(1, nl) - sd / Math.max(1, nd);
}

// 前のフレームのマーカー prev を img の中で追う。shift: マーカーごとに予測したずれ（前のフレームの動き）。
// 追えたマーカーの、prev の番号・角（画像全体の座標）・前のフレームからのずれ
export function trackMarkers(
  img: ImageLike,
  prev: Marker[],
  bitsOf: (id: number) => Uint8Array,
  cells: number,
  shift: (m: Marker, index: number) => Pt = () => [0, 0],
  o: TrackOptions = DEFAULT_TRACK,
): { from: number; id: number; corners: number[]; shift: Pt }[] {
  const out: { from: number; id: number; corners: number[]; shift: Pt }[] = [];
  for (const [from, m] of prev.entries()) {
    const pts = moduleCenters(m.corners, cells);
    if (!pts) continue;
    const bits = bitsOf(m.id);
    const probe = probeOf(img, pts, bits, 1);
    // ずらす量は整数画素（点の画素を先に丸めているので）
    const [px, py] = shift(m, from).map(Math.round);
    const reach = Math.max(3, Math.round(m.side * o.reach));
    // 予測した位置から山登り（2 画素おき → 1 画素）。合わなければ範囲全体を 2 画素おきに探してから山登り
    let best = { dx: px, dy: py, fit: -1, contrast: 0 };
    const consider = (dx: number, dy: number) => {
      const s = score(img, probe, dx, dy);
      if (s.fit > best.fit || (s.fit === best.fit && s.contrast > best.contrast)) {
        best = { dx, dy, ...s };
        return true;
      }
      return false;
    };
    const climb = () => {
      for (const step of [2, 1]) {
        for (let moved = true, n = 0; moved && n < 12; n++) {
          moved = false;
          const c = best;
          for (let dy = -step; dy <= step; dy += step)
            for (let dx = -step; dx <= step; dx += step) if ((dx || dy) && Math.abs(c.dx + dx - px) <= reach && Math.abs(c.dy + dy - py) <= reach && consider(c.dx + dx, c.dy + dy)) moved = true;
        }
      }
    };
    consider(px, py);
    climb();
    if (best.fit < o.minFit) {
      for (let dy = -reach; dy <= reach; dy += 2) for (let dx = -reach; dx <= reach; dx += 2) consider(px + dx, py + dy);
      climb();
    }
    if (best.fit < o.minFit || best.contrast < o.minContrast) continue;
    // 位置を詰める: マスの縁の近くの点も使って、明暗の相関がいちばん大きい所へ 1 画素ずつ（マスの真ん中だけでは、数画素ずれても合ってしまう）
    const finePts = moduleCenters(m.corners, cells, true);
    if (finePts) {
      const fine = probeOf(img, finePts, bits, 9);
      let at = { dx: best.dx, dy: best.dy, c: correlation(img, fine, best.dx, best.dy) };
      for (let it = 0; it < 6; it++) {
        const c = at;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const v = correlation(img, fine, c.dx + dx, c.dy + dy);
            if (v > at.c) at = { dx: c.dx + dx, dy: c.dy + dy, c: v };
          }
        if (at === c) break;
      }
      best = { ...best, dx: at.dx, dy: at.dy };
    }
    out.push({ from, id: m.id, corners: m.corners.map((v, i) => Math.round((v + (i % 2 ? best.dy : best.dx)) * 10) / 10), shift: [best.dx, best.dy] });
  }
  return out;
}
