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

// マーカーの各マス（枠を含む cells × cells）の真ん中の画像上の位置
function moduleCenters(corners: number[], cells: number): Pt[] | null {
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
  for (let r = 0; r < cells; r++) for (let c = 0; c < cells; c++) out.push(applyH(H, c + 0.5, r + 0.5));
  return out;
}

// pts を (dx, dy) ずらしたときの、符号どおりの明暗の割合と明暗の差
function score(img: ImageLike, pts: Pt[], bits: Uint8Array, dx: number, dy: number): { fit: number; contrast: number } {
  const v = new Float32Array(pts.length);
  let sl = 0;
  let sd = 0;
  let nl = 0;
  let nd = 0;
  for (let k = 0; k < pts.length; k++) {
    const xi = Math.round(pts[k][0] + dx);
    const yi = Math.round(pts[k][1] + dy);
    if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return { fit: 0, contrast: 0 };
    const i = (yi * img.width + xi) * 4;
    const m = Math.max(img.data[i], img.data[i + 1], img.data[i + 2]);
    v[k] = m;
    if (bits[k]) {
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
  for (let k = 0; k < pts.length; k++) if (v[k] > mid === bits[k] > 0) ok++;
  return { fit: ok / pts.length, contrast: L - D };
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
    const [px, py] = shift(m, from);
    const reach = Math.max(3, Math.round(m.side * o.reach));
    // 予測した位置から山登り（2 画素おき → 1 画素）。合わなければ範囲全体を 2 画素おきに探してから山登り
    let best = { dx: px, dy: py, fit: -1, contrast: 0 };
    const consider = (dx: number, dy: number) => {
      const s = score(img, pts, bits, dx, dy);
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
    out.push({ from, id: m.id, corners: m.corners.map((v, i) => Math.round((v + (i % 2 ? best.dy : best.dx)) * 10) / 10), shift: [best.dx, best.dy] });
  }
  return out;
}
