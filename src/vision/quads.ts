// OpenCV.js でステッカーらしい四角形を拾う。
// 輝度のエッジ（ステッカー間の黒い隙間）に加えて、a*/b* のエッジ（ステッカーレスで色が隣り合う境界）も使う。
import type { Quad } from "./lattice";

// OpenCV.js には使える型定義がない
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

export interface QuadOptions {
  cannyLow: number;
  cannyHigh: number;
  colorEdges: boolean;
  minAreaFrac: number; // フレーム面積に対する最小
  maxAreaFrac: number;
  minSideRatio: number; // 最短辺 / 最長辺（斜めから見た面も拾えるよう低め）
  grow: number; // 輪郭を外側へ広げる量（px）
}

export const DEFAULT_QUADS: QuadOptions = {
  cannyLow: 20,
  cannyHigh: 60,
  colorEdges: true,
  minAreaFrac: 1 / 4000,
  maxAreaFrac: 1 / 25,
  minSideRatio: 0.18,
  grow: 2,
};

// 凸四角形の各辺を外側へ d だけ平行移動した四角形
function offsetQuad(p: [number, number][], d: number): [number, number][] {
  const area2 = p.reduce((s, a, i) => s + a[0] * p[(i + 1) % 4][1] - p[(i + 1) % 4][0] * a[1], 0);
  const sign = area2 > 0 ? 1 : -1;
  const lines = p.map((a, i) => {
    const b = p[(i + 1) % 4];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    // 外向き法線（向きに依存しないよう面積の符号で決める）
    const nx = (sign * dy) / l;
    const ny = (-sign * dx) / l;
    return { p: [a[0] + nx * d, a[1] + ny * d], d: [dx, dy] };
  });
  return p.map((_, i) => {
    const l1 = lines[(i + 3) % 4];
    const l2 = lines[i];
    const det = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
    if (Math.abs(det) < 1e-9) return p[i];
    const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / det;
    return [l1.p[0] + l1.d[0] * t, l1.p[1] + l1.d[1] * t] as [number, number];
  });
}

function polygonArea(p: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return Math.abs(a) / 2;
}

export function findQuads(cv: CV, rgba: CV, o: QuadOptions = DEFAULT_QUADS): Quad[] {
  const mats: CV[] = [];
  const keep = <T>(m: T): T => (mats.push(m), m);
  const out: Quad[] = [];
  try {
    const gray = keep(new cv.Mat());
    const edges = keep(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, o.cannyLow, o.cannyHigh);
    if (o.colorEdges) {
      const rgb = keep(new cv.Mat());
      const lab = keep(new cv.Mat());
      const ch = keep(new cv.MatVector());
      const e = keep(new cv.Mat());
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      cv.split(lab, ch);
      for (const k of [1, 2]) {
        const c = ch.get(k);
        cv.GaussianBlur(c, c, new cv.Size(5, 5), 0);
        cv.Canny(c, e, o.cannyLow * 0.6, o.cannyHigh * 0.6);
        cv.bitwise_or(edges, e, edges);
        c.delete();
      }
    }
    const kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    cv.dilate(edges, edges, kernel);
    const contours = keep(new cv.MatVector());
    const hierarchy = keep(new cv.Mat());
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const frameArea = rgba.rows * rgba.cols;
    const approx = keep(new cv.Mat());
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > frameArea * o.minAreaFrac && area < frameArea * o.maxAreaFrac) {
        // 斜めから見た細長いステッカーは、周長に比例した許容誤差だと三角形に潰れる。小さい許容から順に試す
        const perimeter = cv.arcLength(c, true);
        let found = false;
        for (const k of [0.02, 0.035, 0.05, 0.07, 0.09]) {
          cv.approxPolyDP(c, approx, k * perimeter, true);
          if (approx.rows <= 4) {
            found = approx.rows === 4;
            break;
          }
        }
        if (found && cv.isContourConvex(approx)) {
          const p = Array.from({ length: 4 }, (_, k) => [approx.data32S[k * 2], approx.data32S[k * 2 + 1]] as [number, number]);
          const sides = p.map((a, k) => Math.hypot(p[(k + 1) % 4][0] - a[0], p[(k + 1) % 4][1] - a[1]));
          const ratio = Math.min(...sides) / Math.max(...sides);
          const fill = area / (polygonArea(p) || 1);
          let anglesOk = true;
          for (let k = 0; k < 4; k++) {
            const a = p[(k + 3) % 4];
            const b = p[k];
            const d = p[(k + 1) % 4];
            const v1 = [a[0] - b[0], a[1] - b[1]];
            const v2 = [d[0] - b[0], d[1] - b[1]];
            const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) || 1);
            if (Math.abs(cos) > 0.9) anglesOk = false; // 内角 26°〜154° のみ（角から見た面は強く歪む）
          }
          if (ratio > o.minSideRatio && fill > 0.82 && fill < 1.2 && anglesOk) {
            // エッジの膨張で内側に縮んだ分を戻す（細いステッカーほど縦横比が狂うため）
            const q = offsetQuad(p, o.grow);
            out.push({
              center: [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4],
              corners: q,
              area: polygonArea(q),
            });
          }
        }
      }
      c.delete();
    }
  } finally {
    for (const m of mats) m.delete();
  }
  // 同じステッカーの内側・外側の輪郭は1つに（小さい方 = ステッカー本体に近い方を残す）
  const unique: Quad[] = [];
  for (const q of out.sort((a, b) => a.area - b.area)) {
    const dup = unique.some((u) => q.area < u.area * 2.2 && Math.hypot(u.center[0] - q.center[0], u.center[1] - q.center[1]) < Math.sqrt(u.area) * 0.35);
    if (!dup) unique.push(q);
  }
  return unique;
}

// OpenCV.js モジュールの初期化（ビルドによって Promise / onRuntimeInitialized / 即時 のいずれか）
export async function initOpenCv(mod: CV): Promise<CV> {
  if (mod?.Mat) return mod;
  if (typeof mod?.then === "function") {
    // then を持つオブジェクトをそのまま resolve すると再度展開されるので包んで受け取る
    const wrapped = await new Promise<{ m: CV }>((resolve) => mod.then((m: CV) => resolve({ m })));
    return wrapped.m?.Mat ? wrapped.m : initOpenCv(wrapped.m);
  }
  await new Promise<void>((resolve) => (mod.onRuntimeInitialized = () => resolve()));
  return mod;
}
