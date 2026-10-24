// OpenCV.js でステッカーらしい四角形を拾う。候補は 2 通りの方法で集める:
//   1. エッジ: 輝度のエッジ（ステッカー間の黒い隙間）と a*/b* のエッジ（ステッカーレスで色が隣り合う境界）の輪郭
//   2. 明るい塊: 黒い本体より明るい領域（局所的な二値化）。反射でステッカーの中にエッジができても 1 つの塊のまま
// 実物のステッカーは角が丸いので、輪郭を多角形近似すると角の位置がずれる。凸包から面積最大の四角形を選び、
// 面積が輪郭と同じになるよう広げて、ステッカーの四角形とする。
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
  blobs: boolean; // 明るい塊からも候補を拾う（黒い本体のキューブ）
  grooves: boolean; // 溝で区切られた領域からも候補を拾う（ステッカーレス）
  grooveThreshold: number; // ブラックハットの値がこれを超えたら溝
  grooveErode: number; // 溝で区切った領域を縮める大きさ（px、奇数）
}

export const DEFAULT_QUADS: QuadOptions = {
  cannyLow: 20,
  cannyHigh: 60,
  colorEdges: true,
  minAreaFrac: 1 / 4000,
  maxAreaFrac: 1 / 3, // ステッカーレスで同色がつながったブロック（最大で面全体）も拾う
  minSideRatio: 0.18,
  grow: 2,
  blobs: true,
  grooves: false, // 普段は使わない（面が見つからないフレームだけ pipeline が有効にしてやり直す）
  grooveThreshold: 10,
  grooveErode: 7,
};

type P = [number, number];

// 凸多角形の頂点から、面積最大の四角形（頂点の並びを保つ）。n は 30 程度までを想定
export function maxAreaQuad(pts: P[]): P[] | null {
  const n = pts.length;
  if (n < 4) return null;
  const tri = (a: P, b: P, c: P) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  let best = -1;
  let out: P[] | null = null;
  // 対角線 (i, j) を決めると、両側でそれぞれ最も遠い頂点を選べばよい
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      let a = -1;
      let ka = -1;
      for (let k = i + 1; k < j; k++) {
        const t = tri(pts[i], pts[j], pts[k]);
        if (t > a) (a = t), (ka = k);
      }
      let b = -1;
      let kb = -1;
      for (let k = j + 1; k < n + i; k++) {
        const t = tri(pts[i], pts[j], pts[k % n]);
        if (t > b) (b = t), (kb = k % n);
      }
      if (ka < 0 || kb < 0) continue;
      if (a + b > best) {
        best = a + b;
        out = [pts[i], pts[ka], pts[j], pts[kb]];
      }
    }
  }
  return out;
}

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

// 輪郭 1 つから、ステッカーらしい四角形を作る（だめなら null）
function quadFromContour(cv: CV, c: CV, frameArea: number, o: QuadOptions, hullMat: CV, approx: CV, minSolidity = 0.86): Quad | null {
  const area = cv.contourArea(c);
  if (!(area > frameArea * o.minAreaFrac && area < frameArea * o.maxAreaFrac)) return null;
  cv.convexHull(c, hullMat, false, true);
  const hullArea = cv.contourArea(hullMat);
  // 塊が凸に近いこと（ステッカーは凸。手や背景の模様は凹みが多い）
  if (hullArea <= 0 || area / hullArea < minSolidity) return null;
  // 凸包の頂点を減らしてから、面積最大の四角形を選ぶ
  const per = cv.arcLength(hullMat, true);
  cv.approxPolyDP(hullMat, approx, Math.max(1, 0.01 * per), true);
  let pts: P[] = Array.from({ length: approx.rows }, (_, k) => [approx.data32S[k * 2], approx.data32S[k * 2 + 1]] as P);
  if (pts.length > 32) pts = pts.filter((_, k) => k % Math.ceil(pts.length / 32) === 0);
  const p = maxAreaQuad(pts);
  if (!p) return null;
  const quadArea = polygonArea(p);
  if (quadArea <= 0) return null;
  // 丸い角なら凸包は四角形より少し大きい（角の丸みが大きくても 1.3 倍まで）。円や三角形はここで落ちる
  const fill = hullArea / quadArea;
  if (fill < 0.97 || fill > 1.3) return null;
  const sides = p.map((a, k) => Math.hypot(p[(k + 1) % 4][0] - a[0], p[(k + 1) % 4][1] - a[1]));
  if (Math.min(...sides) / Math.max(...sides) <= o.minSideRatio) return null;
  for (let k = 0; k < 4; k++) {
    const a = p[(k + 3) % 4];
    const b = p[k];
    const d = p[(k + 1) % 4];
    const v1 = [a[0] - b[0], a[1] - b[1]];
    const v2 = [d[0] - b[0], d[1] - b[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) || 1);
    if (Math.abs(cos) > 0.9) return null; // 内角 26°〜154° のみ（角から見た面は強く歪む）
  }
  // 丸い角で内側に入った分を、面積が凸包と同じになるよう中心から広げて戻す。さらにエッジの膨張で縮んだ分を戻す
  const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
  const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
  const sc = Math.min(1.14, Math.sqrt(fill));
  const q = offsetQuad(
    p.map(([x, y]) => [cx + (x - cx) * sc, cy + (y - cy) * sc] as P),
    o.grow,
  );
  return {
    center: [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4],
    corners: q,
    area: polygonArea(q),
  };
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
    const rgb = keep(new cv.Mat());
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    if (o.colorEdges) {
      const lab = keep(new cv.Mat());
      const ch = keep(new cv.MatVector());
      const e = keep(new cv.Mat());
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
    const frameArea = rgba.rows * rgba.cols;
    const approx = keep(new cv.Mat());
    const hullMat = keep(new cv.Mat());
    const collect = (src: CV, mode: number, extraGrow = 0, minSolidity = 0.86) => {
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      try {
        cv.findContours(src, contours, hierarchy, mode, cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < contours.size(); i++) {
          const c = contours.get(i);
          const q = quadFromContour(cv, c, frameArea, extraGrow ? { ...o, grow: o.grow + extraGrow } : o, hullMat, approx, minSolidity);
          if (q) out.push(q);
          c.delete();
        }
      } finally {
        contours.delete();
        hierarchy.delete();
      }
    };
    collect(edges, cv.RETR_LIST);
    if (o.blobs) {
      // 明るさ（HSV の V = RGB の最大値）を周囲の平均と比べて二値化: 黒い本体と隙間が 0、ステッカーが 1
      const hsv = keep(new cv.Mat());
      const ch = keep(new cv.MatVector());
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      cv.split(hsv, ch);
      const v = keep(ch.get(2));
      cv.GaussianBlur(v, v, new cv.Size(3, 3), 0);
      const mask = keep(new cv.Mat());
      const block = Math.max(15, Math.round(Math.min(rgba.cols, rgba.rows) / 10) | 1);
      cv.adaptiveThreshold(v, mask, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, block, -6);
      // 細いつながり（隙間が狭いところ）を切る
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
      collect(mask, cv.RETR_EXTERNAL);
    }
    if (o.grooves) {
      // ステッカーレス: ピースの間の溝（細く暗い線）をブラックハットで強調し、溝で区切られた領域をセルとする。
      // 同じ色が隣り合ってエッジも明るさの差も出ないところを、溝で分けられる
      const hsv = keep(new cv.Mat());
      const ch = keep(new cv.MatVector());
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      cv.split(hsv, ch);
      const v = keep(ch.get(2));
      const k = Math.max(5, Math.round(Math.min(rgba.cols, rgba.rows) / 50) | 1);
      const ell = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
      const bh = keep(new cv.Mat());
      cv.morphologyEx(v, bh, cv.MORPH_BLACKHAT, ell);
      const mask = keep(new cv.Mat());
      cv.threshold(bh, mask, o.grooveThreshold, 255, cv.THRESH_BINARY_INV);
      // 暗いところ（キューブの黒い本体・影）はセルではない
      const bright = keep(new cv.Mat());
      cv.threshold(v, bright, 60, 255, cv.THRESH_BINARY);
      cv.bitwise_and(mask, bright, mask);
      // 色や明るさのエッジ（面の折れ目・違う色の境界・キューブの輪郭）も境界にする
      const notEdges = keep(new cv.Mat());
      cv.bitwise_not(edges, notEdges);
      cv.bitwise_and(mask, notEdges, mask);
      // 溝の切れ目から隣のセルや背景へつながらないよう、セルを縮めてから輪郭を取る（四角形は外側へ広げ直す）
      const shrink = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(o.grooveErode, o.grooveErode)));
      cv.erode(mask, mask, shrink);
      // 映り込みや表面の模様でできた小さな穴・切れ込みを埋める（輪郭がぎざぎざだと凸でないとして落ちる）
      cv.medianBlur(mask, mask, 5);
      collect(mask, cv.RETR_EXTERNAL, (o.grooveErode - 1) / 2, 0.75);
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
