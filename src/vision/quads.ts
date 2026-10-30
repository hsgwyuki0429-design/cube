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
  refSize?: { cols: number; rows: number }; // 面積の割合・窓の大きさの基準（切り出しのときはフレーム全体。既定は画像）
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

// 1 フレームの四角形の候補。途中の画像（エッジ・明るさ・溝の強さ）を残しておき、溝の候補をしきい値を変えて何度も作るときに
// 使い回す（精密解析では面が見つからないフレームで、溝の候補を 2 通りのしきい値で試す。毎回作り直すと 1 フレーム 300ms 近く）。
// 結果は findQuads と同じ。使い終わったら delete()
export class QuadFinder {
  private readonly mats: CV[] = [];
  private readonly edges: CV; // 輝度 + a*/b* のエッジ（膨張済み）
  private readonly value: CV; // 明るさ（HSV の V = max(R, G, B)）
  private blackhat: CV | null = null; // 溝の強さ（明るさのブラックハット）
  private readonly ref: { cols: number; rows: number };
  private readonly frameArea: number;
  private readonly approx: CV;
  private readonly hullMat: CV;
  private readonly found: Quad[] = []; // エッジと明るい塊の候補（重複を除く前）

  constructor(
    private readonly cv: CV,
    rgba: CV,
    private readonly o: QuadOptions = DEFAULT_QUADS,
  ) {
    try {
      this.edges = this.keep(new cv.Mat());
      const gray = new cv.Mat();
      try {
        cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
        cv.Canny(gray, this.edges, o.cannyLow, o.cannyHigh);
      } finally {
        gray.delete();
      }
      if (o.colorEdges) {
        const lab = new cv.Mat();
        const ch = new cv.MatVector();
        const e = new cv.Mat();
        try {
          cv.cvtColor(rgba, lab, cv.COLOR_RGB2Lab); // 4 チャンネルのまま（アルファは使わない）
          cv.split(lab, ch);
          for (const k of [1, 2]) {
            const c = ch.get(k);
            cv.GaussianBlur(c, c, new cv.Size(5, 5), 0);
            cv.Canny(c, e, o.cannyLow * 0.6, o.cannyHigh * 0.6);
            cv.bitwise_or(this.edges, e, this.edges);
            c.delete();
          }
        } finally {
          lab.delete();
          ch.delete();
          e.delete();
        }
      }
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(this.edges, this.edges, kernel);
      this.ref = o.refSize ?? { cols: rgba.cols, rows: rgba.rows };
      this.frameArea = this.ref.rows * this.ref.cols;
      this.approx = this.keep(new cv.Mat());
      this.hullMat = this.keep(new cv.Mat());
      this.value = this.keep(new cv.Mat(rgba.rows, rgba.cols, cv.CV_8UC1));
      maxRgb(rgba.data, this.value.data);
      this.collect(this.edges, cv.RETR_LIST, this.found);
      if (o.blobs) {
        // 明るさ（HSV の V = RGB の最大値）を周囲の平均と比べて二値化: 黒い本体と隙間が 0、ステッカーが 1
        const v = new cv.Mat();
        const mask = new cv.Mat();
        try {
          cv.GaussianBlur(this.value, v, new cv.Size(3, 3), 0);
          const block = Math.max(15, Math.round(Math.min(this.ref.cols, this.ref.rows) / 10) | 1);
          cv.adaptiveThreshold(v, mask, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, block, -6);
          // 細いつながり（隙間が狭いところ）を切る
          cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
          this.collect(mask, cv.RETR_EXTERNAL, this.found);
        } finally {
          v.delete();
          mask.delete();
        }
      }
      kernel.delete();
    } catch (e) {
      this.delete();
      throw e;
    }
  }

  private keep<T>(m: T): T {
    this.mats.push(m);
    return m;
  }

  private collect(src: CV, mode: number, out: Quad[], extraGrow = 0, minSolidity = 0.86): void {
    const cv = this.cv;
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const o = extraGrow ? { ...this.o, grow: this.o.grow + extraGrow } : this.o;
    try {
      cv.findContours(src, contours, hierarchy, mode, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const q = quadFromContour(cv, c, this.frameArea, o, this.hullMat, this.approx, minSolidity);
        if (q) out.push(q);
        c.delete();
      }
    } finally {
      contours.delete();
      hierarchy.delete();
    }
  }

  // エッジと明るい塊の候補
  quads(): Quad[] {
    return dedupe(this.found);
  }

  // 溝で区切られた領域の候補も加える（ステッカーレス）。ピースの間の溝（細く暗い線）をブラックハットで強調し、
  // 溝で区切られた領域をセルとする。同じ色が隣り合ってエッジも明るさの差も出ないところを、溝で分けられる
  withGrooves(threshold = this.o.grooveThreshold): Quad[] {
    const cv = this.cv;
    const o = this.o;
    if (!this.blackhat) {
      // ブラックハット（楕円で閉じた明るさ − 明るさ）
      const k = Math.max(5, Math.round(Math.min(this.ref.cols, this.ref.rows) / 50) | 1);
      const closed = new cv.Mat();
      try {
        morphEllipse(cv, this.value, closed, "dilate", k);
        morphEllipse(cv, closed, closed, "erode", k);
        this.blackhat = this.keep(new cv.Mat());
        cv.subtract(closed, this.value, this.blackhat);
      } finally {
        closed.delete();
      }
    }
    const mask = new cv.Mat();
    const tmp = new cv.Mat();
    const out = [...this.found];
    try {
      cv.threshold(this.blackhat, mask, threshold, 255, cv.THRESH_BINARY_INV);
      // 暗いところ（キューブの黒い本体・影）はセルではない
      cv.threshold(this.value, tmp, 60, 255, cv.THRESH_BINARY);
      cv.bitwise_and(mask, tmp, mask);
      // 色や明るさのエッジ（面の折れ目・違う色の境界・キューブの輪郭）も境界にする
      cv.bitwise_not(this.edges, tmp);
      cv.bitwise_and(mask, tmp, mask);
      // 溝の切れ目から隣のセルや背景へつながらないよう、セルを縮めてから輪郭を取る（四角形は外側へ広げ直す）
      morphEllipse(cv, mask, mask, "erode", o.grooveErode);
      // 映り込みや表面の模様でできた小さな穴・切れ込みを埋める（輪郭がぎざぎざだと凸でないとして落ちる）
      median5Binary(cv, mask, tmp);
      this.collect(mask, cv.RETR_EXTERNAL, out, (o.grooveErode - 1) / 2, 0.75);
    } finally {
      mask.delete();
      tmp.delete();
    }
    return dedupe(out);
  }

  delete(): void {
    for (const m of this.mats) m.delete();
    this.mats.length = 0;
  }
}

// 楕円（k×k）の構造要素での膨張・収縮を、縦・横の長方形での処理の組み合わせで行う（cv.dilate / cv.erode に楕円を渡したのと
// 画素単位で同じ結果。wasm の OpenCV では楕円のままより 2 倍以上速い）。楕円は中心から離れた行ほど幅が狭いので、
// 「高さ 2h+1・幅 w(h)」の長方形の和集合になり、和集合での膨張は各長方形での膨張の最大（収縮は最小）。
// 縦の窓は 1 段ずつ広げて使い回す。画像の外は既定（膨張では無視・収縮でも無視）なので、組み合わせても端まで同じ
const ellipseRects = new Map<number, [number, number][]>(); // k → [幅, 高さ]（高さの小さい順）
export function morphEllipse(cv: CV, src: CV, dst: CV, op: "dilate" | "erode", k: number): void {
  let rects = ellipseRects.get(k);
  if (!rects) {
    const ell = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
    const width = (r: number) => {
      let w = 0;
      for (let c = 0; c < k; c++) if (ell.ucharAt(r, c)) w++;
      return w;
    };
    const c0 = (k - 1) / 2;
    rects = [];
    for (let h = 0; h <= c0; h++) {
      const w = width(c0 + h);
      if (h === c0 || width(c0 + h + 1) !== w) rects.push([w, 2 * h + 1]);
    }
    ell.delete();
    ellipseRects.set(k, rects);
  }
  // Mat の clone() はこのビルドではデータを共有する（JS の参照の複製）ので copyTo で写す
  const col = new cv.Mat();
  src.copyTo(col);
  const tmp = new cv.Mat();
  const apply = (from: CV, to: CV, w: number, h: number) => {
    const kk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(w, h));
    if (op === "dilate") cv.dilate(from, to, kk);
    else cv.erode(from, to, kk);
    kk.delete();
  };
  try {
    let height = 1;
    rects.forEach(([w, h], i) => {
      // 縦の窓を height → h に広げる（窓 h − height + 1 を重ねる）
      if (h > height) apply(col, col, 1, h - height + 1);
      height = h;
      const to = i === 0 ? dst : tmp;
      if (w > 1) apply(col, to, w, 1);
      else col.copyTo(to);
      if (i > 0) (op === "dilate" ? cv.max : cv.min)(dst, tmp, dst);
    });
  } finally {
    col.delete();
    tmp.delete();
  }
}

// 2 値（0 / 255）の画像の 5×5 のメディアン（cv.medianBlur と同じ結果）: 25 画素のうち 13 以上が 255 なら 255。
// 箱フィルタで数える方が wasm の OpenCV では数倍速い。端は medianBlur と同じく端の画素を延ばす
export function median5Binary(cv: CV, mask: CV, tmp: CV): void {
  cv.threshold(mask, tmp, 127, 1, cv.THRESH_BINARY);
  cv.boxFilter(tmp, tmp, -1, new cv.Size(5, 5), new cv.Point(-1, -1), false, cv.BORDER_REPLICATE);
  cv.threshold(tmp, mask, 12, 255, cv.THRESH_BINARY);
}

// 同じステッカーの内側・外側の輪郭は1つに（小さい方 = ステッカー本体に近い方を残す）
function dedupe(out: Quad[]): Quad[] {
  const unique: Quad[] = [];
  for (const q of [...out].sort((a, b) => a.area - b.area)) {
    const dup = unique.some((u) => q.area < u.area * 2.2 && Math.hypot(u.center[0] - q.center[0], u.center[1] - q.center[1]) < Math.sqrt(u.area) * 0.35);
    if (!dup) unique.push(q);
  }
  return unique;
}

// RGBA の画素から max(R, G, B)（HSV の V と同じ値）
export function maxRgb(src: Uint8ClampedArray | Uint8Array, dst: Uint8Array): void {
  if (src.byteOffset % 4 === 0) {
    // 1 画素を 1 回で読む（リトルエンディアン: R が下位のバイト）
    const px = new Uint32Array(src.buffer, src.byteOffset, dst.length);
    for (let j = 0; j < dst.length; j++) {
      const v = px[j];
      const r = v & 255;
      const g = (v >>> 8) & 255;
      const b = (v >>> 16) & 255;
      dst[j] = r > g ? (r > b ? r : b) : g > b ? g : b;
    }
    return;
  }
  for (let i = 0, j = 0; j < dst.length; i += 4, j++) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    dst[j] = r > g ? (r > b ? r : b) : g > b ? g : b;
  }
}

export function findQuads(cv: CV, rgba: CV, o: QuadOptions = DEFAULT_QUADS): Quad[] {
  const f = new QuadFinder(cv, rgba, o);
  try {
    return o.grooves ? f.withGrooves() : f.quads();
  } finally {
    f.delete();
  }
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
