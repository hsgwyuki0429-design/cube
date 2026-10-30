// 色付き ArUco マーカーの検出（OpenCV.js の ArucoDetector）。DOM もカメラも知らない（Node でも動く）。
// マーカーの「白」のセルをステッカーの色に置き換えているので、前処理を切り替えて比べる:
//   gray … 普通のグレースケール。青・赤のセルは暗くなり黒との差が小さい
//   max  … max(R,G,B)（HSV の V）。色付きのセルも明るく残る
import { type Pt, applyH, fitHomography } from "../vision/homography";
import { type CV, maxRgb } from "../vision/quads";
import { type StickerScheme, codesOf, makeDictionary, markerBits, markerSize } from "./codes";

export type Preprocess = "gray" | "max";

// DetectorParameters のうち数値で変えられるもの（名前は OpenCV のまま）
export interface ArucoParams {
  adaptiveThreshWinSizeMin: number;
  adaptiveThreshWinSizeMax: number;
  adaptiveThreshWinSizeStep: number;
  adaptiveThreshConstant: number;
  minMarkerPerimeterRate: number;
  maxMarkerPerimeterRate: number;
  polygonalApproxAccuracyRate: number;
  minCornerDistanceRate: number;
  minMarkerDistanceRate: number;
  minGroupDistance: number;
  cornerRefinementMethod: number; // 0 なし / 1 サブピクセル / 2 輪郭
  perspectiveRemovePixelPerCell: number;
  perspectiveRemoveIgnoredMarginPerCell: number;
  maxErroneousBitsInBorderRate: number;
  minOtsuStdDev: number;
  errorCorrectionRate: number;
}

export const PARAM_KEYS: (keyof ArucoParams)[] = [
  "adaptiveThreshWinSizeMin",
  "adaptiveThreshWinSizeMax",
  "adaptiveThreshWinSizeStep",
  "adaptiveThreshConstant",
  "minMarkerPerimeterRate",
  "maxMarkerPerimeterRate",
  "polygonalApproxAccuracyRate",
  "minCornerDistanceRate",
  "minMarkerDistanceRate",
  "minGroupDistance",
  "cornerRefinementMethod",
  "perspectiveRemovePixelPerCell",
  "perspectiveRemoveIgnoredMarginPerCell",
  "maxErroneousBitsInBorderRate",
  "minOtsuStdDev",
  "errorCorrectionRate",
];

// 調整版（方式 c）。小さいマーカー・色付きセルの弱いコントラスト・少しのぼけに寄せる
export const TUNED_PARAMS: Partial<ArucoParams> = {
  adaptiveThreshWinSizeMin: 3,
  adaptiveThreshWinSizeMax: 43,
  adaptiveThreshWinSizeStep: 4, // 窓を細かく試す（遅くなる）
  adaptiveThreshConstant: 5,
  minMarkerPerimeterRate: 0.01, // 1080p で辺 5px まで（既定 0.03 は辺 14px）
  // polygonalApproxAccuracyRate（輪郭の四角形近似の許容）は緩めない: 0.05 にすると、マーカーが密に並ぶキューブの上で
  // 読めるマーカーが 27 → 11 に減った（合成のキューブ。シートでは差がない）
  minOtsuStdDev: 3, // 青・赤のセルと黒の差が小さい
  perspectiveRemovePixelPerCell: 8,
  perspectiveRemoveIgnoredMarginPerCell: 0.2,
  cornerRefinementMethod: 1,
};

// 符号の種類ごとの既定（方式のパラメータで上書きできる）。入れ子の候補をまとめない設定（minGroupDistance を小さく）は、
// unique54 で本物まで読めなくなったので使わない（外側の偽物は MIN_FIT で捨てて、内側を読み直す: rescueInner）
// 3×3 の符号は二値化の窓を 3〜23 の 5 刻みで試す（既定は 10 刻み）。明るいマスが離れて並ぶ符号（12 種類の緑）は窓の大きさに
// よって枠が途切れて四角の候補にならず、合成画像で 12 種類の緑 77% → 81%・全体 88% → 91%（取りこぼしの救済と合わせて）。
// 処理は 1280×720 で 25 → 35ms。精密解析（時間をかけてよい）は 3〜33（THOROUGH_PARAMS、55ms）
const WINDOWS3: Partial<ArucoParams> = { adaptiveThreshWinSizeStep: 5, adaptiveThreshWinSizeMax: 23 };
const SCHEME_PARAMS: Record<StickerScheme, Partial<ArucoParams>> = { aruco54: {}, aruco12: WINDOWS3, unique54: WINDOWS3 };
export const THOROUGH_PARAMS: Partial<ArucoParams> = { adaptiveThreshWinSizeStep: 5, adaptiveThreshWinSizeMax: 33 };
const MIN_FIT = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.ARUCO_MIN_FIT ?? 0.85);

export interface DetectorConfig {
  name: string;
  preprocess: Preprocess;
  params: Partial<ArucoParams>;
}

export const DEFAULT_CONFIGS: DetectorConfig[] = [
  { name: "a: グレー", preprocess: "gray", params: {} },
  { name: "b: max(RGB)", preprocess: "max", params: {} },
  { name: "c: グレー+調整", preprocess: "gray", params: TUNED_PARAMS },
  { name: "b+c: max(RGB)+調整", preprocess: "max", params: TUNED_PARAMS },
];

export interface Marker {
  id: number;
  corners: number[]; // x0,y0..x3,y3（マーカーの左上・右上・右下・左下。上 = 印刷したマーカーの上辺）
  side: number; // 辺の長さの平均（px）
  angle: number; // 上辺の向き（度、画像の右向きが 0、時計回りが正）
  rgb: [number, number, number]; // 明るいセル（色付き）の平均
  contrastGray: number; // 明るいセル − 黒いセル（グレー）
  contrastMax: number; // 同じく max(R,G,B)
  fit: number; // マスの中心付近の点のうち、明暗が符号どおりの割合（明るいセルと黒いセルの平均の中間で分ける）
}

export interface ImageLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface DetectResult {
  markers: Marker[];
  ms: number; // 前処理 + 検出 + 色の測定
}

// 画像の一部（左上 x, y・幅 w・高さ h）
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 画像の一部を切り出す（そのままの画素）
export function cropRegion(img: ImageLike, r: Region): ImageLike {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const from = ((r.y + y) * img.width + r.x) * 4;
    out.set(img.data.subarray(from, from + r.w * 4), y * r.w * 4);
  }
  return { data: out, width: r.w, height: r.h };
}

// 1 フレームに複数の方式を順に当てる。Mat は使い回す
export class ArucoBench {
  private dict: any;
  private detectors: any[];
  private cells: number; // マーカーの枠を含むマスの数（4×4 の符号なら 6）
  private rgba: any = null;
  private gray: any = null;
  private max: any = null;
  private params: Partial<ArucoParams>[];
  private rateScale = 1; // マーカーの大きさの範囲（周の長さの割合）に掛けている倍率（切り出しのとき）

  constructor(
    private cv: CV,
    readonly configs: DetectorConfig[],
    readonly scheme: StickerScheme = "aruco54",
  ) {
    this.dict = makeDictionary(cv, scheme);
    this.cells = markerSize(scheme) + 2;
    this.params = configs.map((c) => ({ ...SCHEME_PARAMS[scheme], ...c.params }));
    this.detectors = this.params.map((params) => {
      const p = this.detectorParams(params, 1);
      const det = new cv.aruco_ArucoDetector(this.dict, p, new cv.aruco_RefineParameters(10, 3, true));
      p.delete();
      return det;
    });
  }

  // scale: マーカーの大きさの範囲（周の長さの割合。OpenCV は画像の長辺に掛ける）に掛ける倍率
  private detectorParams(params: Partial<ArucoParams>, scale: number): any {
    const p = new this.cv.aruco_DetectorParameters();
    for (const k of PARAM_KEYS) {
      const v = params[k];
      if (typeof v === "number" && Number.isFinite(v)) p[k] = v;
    }
    p.minMarkerPerimeterRate *= scale;
    p.maxMarkerPerimeterRate *= scale;
    return p;
  }

  private setRateScale(scale: number): void {
    if (scale === this.rateScale) return;
    this.rateScale = scale;
    this.detectors.forEach((det, i) => {
      const p = this.detectorParams(this.params[i], scale);
      det.setDetectorParameters(p);
      p.delete();
    });
  }

  // region: 画像のこの部分だけで検出する（精密解析で、直前のフレームのキューブの周り）。マーカーの大きさの範囲は画像全体で
  // 検出したときと同じ画素数にする。角の座標は画像全体の座標で返す
  detect(img: ImageLike, region?: Region): DetectResult[] {
    if (region) {
      this.setRateScale(Math.max(img.width, img.height) / Math.max(region.w, region.h));
      const out = this.detectIn(cropRegion(img, region));
      for (const r of out)
        for (const m of r.markers) m.corners = m.corners.map((v, i) => Math.round((v + (i % 2 ? region.y : region.x)) * 10) / 10);
      return out;
    }
    this.setRateScale(1);
    return this.detectIn(img);
  }

  private detectIn(img: ImageLike): DetectResult[] {
    const cv = this.cv;
    const { width: w, height: h } = img;
    if (!this.rgba || this.rgba.cols !== w || this.rgba.rows !== h) {
      this.freeMats();
      this.rgba = new cv.Mat(h, w, cv.CV_8UC4);
      this.gray = new cv.Mat(h, w, cv.CV_8UC1);
      this.max = new cv.Mat(h, w, cv.CV_8UC1);
    }
    this.rgba.data.set(img.data);
    // 前処理の時間。同じ前処理を使い回した方式にも、その時間を含める
    const prepMs: Partial<Record<Preprocess, number>> = {};
    const out: DetectResult[] = [];
    for (let i = 0; i < this.configs.length; i++) {
      const pre = this.configs[i].preprocess;
      if (prepMs[pre] === undefined) {
        const p0 = now();
        if (pre === "gray") cv.cvtColor(this.rgba, this.gray, cv.COLOR_RGBA2GRAY);
        else maxChannel(img.data, this.max.data);
        prepMs[pre] = now() - p0;
      }
      const t0 = now();
      const corners = new cv.MatVector();
      const ids = new cv.Mat();
      const rejected = new cv.MatVector();
      const markers: Marker[] = [];
      try {
        this.detectors[i].detectMarkers(pre === "gray" ? this.gray : this.max, corners, ids, rejected);
        const count = ids.total();
        for (let k = 0; k < count; k++) {
          const id = ids.data32S[k];
          const c = Array.from(corners.get(k).data32F as Float32Array);
          let m: Marker | null = this.describe(img, id, c);
          // 符号の空きが少ない辞書（unique54）は、ずれた四角（ステッカーの外側の色の縁ごと拾った候補）も別の符号として読めてしまい、
          // OpenCV は入れ子の外側が読めると内側の本物を試さない。マスの中心の明暗が符号どおりでなければ、色の縁の幅だけ内側を読み直す
          if (this.scheme === "unique54" && m.fit < MIN_FIT) m = this.rescueInner(img, c);
          if (m) markers.push(m);
        }
        // 3×3 の符号: OpenCV が符号に合わないとして捨てた四角を、マスの中心付近だけで読み直す（rescueRejected）
        const codes = codesOf(this.scheme);
        if (codes.length) {
          const rej = Array.from({ length: rejected.size() }, (_, k) => Array.from(rejected.get(k).data32F as Float32Array));
          for (const r of rescueRejected(img, rej, codes, markers)) {
            const m = this.describe(img, r.id, r.corners);
            if (m.fit >= MIN_FIT) markers.push(m);
          }
        }
      } finally {
        corners.delete();
        ids.delete();
        rejected.delete();
      }
      out.push({ markers, ms: now() - t0 + (prepMs[pre] ?? 0) });
    }
    return out;
  }

  private describe(img: ImageLike, id: number, c: number[]): Marker {
    const pts: Pt[] = [0, 1, 2, 3].map((i) => [c[i * 2], c[i * 2 + 1]]);
    let side = 0;
    for (let i = 0; i < 4; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      side += Math.hypot(b[0] - a[0], b[1] - a[1]) / 4;
    }
    const angle = (Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) * 180) / Math.PI;
    const m = measureCells(img, pts, markerBits(this.scheme, id), this.cells);
    return { id, corners: c.map((v) => Math.round(v * 10) / 10), side, angle, ...m };
  }

  // 外側の四角（ステッカーの縁）の内側 STICKER_MARGIN にある本物のマーカーを自前で読む（3×3 の符号）
  private rescueInner(img: ImageLike, c: number[]): Marker | null {
    const pts: Pt[] = [0, 1, 2, 3].map((i) => [c[i * 2], c[i * 2 + 1]]);
    const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
    const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
    const k = 1 - 2 * STICKER_MARGIN;
    const inner: Pt[] = pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
    const hit = decodeQuad(img, inner, codesOf(this.scheme));
    if (!hit) return null;
    // 符号が時計回りに rot 回だけ回って写っている → マーカーの左上はサンプリングの角 rot
    const ordered = [0, 1, 2, 3].flatMap((i) => inner[(i + hit.rot) % 4]);
    const m = this.describe(img, hit.id, ordered);
    return m.fit >= MIN_FIT ? m : null;
  }

  private freeMats(): void {
    for (const m of [this.rgba, this.gray, this.max]) m?.delete();
    this.rgba = this.gray = this.max = null;
  }

  delete(): void {
    this.freeMats();
    for (const d of this.detectors) d.delete();
    this.detectors = [];
    this.dict.delete();
  }
}

const STICKER_MARGIN = 0.08; // ステッカーの辺に対する色の縁（印刷用 PDF と同じ）

// 四角の中の (n+2)×(n+2) のマスを読み、枠が黒く、中の n×n が辞書のどれか（回転を含む）に一致すれば ID と回転
export function decodeQuad(img: ImageLike, pts: Pt[], codes: number[], n = 3): { id: number; rot: number } | null {
  const cells = n + 2;
  const H = fitHomography(
    [
      [0, 0],
      [cells, 0],
      [cells, cells],
      [0, cells],
    ],
    pts,
  );
  if (!H) return null;
  const val: number[] = [];
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      let sum = 0;
      let cnt = 0;
      for (const dy of [-0.2, 0, 0.2]) {
        for (const dx of [-0.2, 0, 0.2]) {
          const [x, y] = applyH(H, c + 0.5 + dx, r + 0.5 + dy);
          const xi = Math.round(x);
          const yi = Math.round(y);
          if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) continue;
          const i = (yi * img.width + xi) * 4;
          sum += Math.max(img.data[i], img.data[i + 1], img.data[i + 2]);
          cnt++;
        }
      }
      if (!cnt) return null;
      val.push(sum / cnt);
    }
  }
  const lo = Math.min(...val);
  const hi = Math.max(...val);
  if (hi - lo < 30) return null;
  const thr = (lo + hi) / 2;
  for (let r = 0; r < cells; r++) for (let c = 0; c < cells; c++) if ((r === 0 || c === 0 || r === cells - 1 || c === cells - 1) && val[r * cells + c] > thr) return null;
  let code = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (val[(r + 1) * cells + c + 1] > thr) code |= 1 << (r * n + c);
  for (let id = 0; id < codes.length; id++) {
    let x = codes[id];
    for (let rot = 0; rot < 4; rot++, x = rotCode(x, n)) if (x === code) return { id, rot };
  }
  return null;
}

// OpenCV が符号に合わないとして捨てた四角（rejected）を、マスの中心付近だけで読み直す（3×3 の符号）。
// 明るいマスが離れて並ぶ符号（12 種類の緑など）は、ぶれるとマス全体の画素の多数決では暗いマスと読まれて捨てられる。
// すでに読めたマーカーと重なるものは除く。corners は (x0, y0, …) の 4 隅、戻り値の角はマーカーの向き（左上から時計回り）
export function rescueRejected(img: ImageLike, rejected: number[][], codes: number[], found: { corners: number[]; side: number }[]): { id: number; corners: number[] }[] {
  const out: { id: number; corners: number[] }[] = [];
  const centers = found.map((m) => ({ x: (m.corners[0] + m.corners[2] + m.corners[4] + m.corners[6]) / 4, y: (m.corners[1] + m.corners[3] + m.corners[5] + m.corners[7]) / 4, r: m.side * 0.5 }));
  for (const c of rejected) {
    const pts: Pt[] = [0, 1, 2, 3].map((i) => [c[i * 2], c[i * 2 + 1]]);
    const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
    const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
    if (centers.some((q) => Math.hypot(q.x - cx, q.y - cy) < q.r)) continue;
    const hit = decodeQuad(img, pts, codes);
    if (!hit) continue;
    const corners = [0, 1, 2, 3].flatMap((i) => pts[(i + hit.rot) % 4]);
    out.push({ id: hit.id, corners });
    const side = (Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) + Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1])) / 2;
    centers.push({ x: cx, y: cy, r: side * 0.5 });
  }
  return out;
}

// 符号を時計回りに 90°（ビット r*n+c → c*n + (n-1-r)）
function rotCode(code: number, n: number): number {
  let out = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if ((code >> (r * n + c)) & 1) out |= 1 << (c * n + (n - 1 - r));
  return out;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// max(R, G, B)（HSV の V）
export const maxChannel = maxRgb;

// マーカーのセルの中心付近（3×3 点）を読み、明るいセルの色と、明るいセル − 黒いセルの差を出す
// bits: 枠を含む cells×cells（1 = 明るい）
export function measureCells(img: ImageLike, corners: Pt[], bits: Uint8Array, cells = 6): Pick<Marker, "rgb" | "contrastGray" | "contrastMax" | "fit"> {
  const H = fitHomography(
    [
      [0, 0],
      [cells, 0],
      [cells, cells],
      [0, cells],
    ],
    corners,
  );
  const light = [0, 0, 0, 0, 0]; // r g b gray max の合計
  const dark = [0, 0, 0, 0, 0];
  let nl = 0;
  let nd = 0;
  const samples: { v: number; light: boolean }[] = []; // max(R,G,B) と、符号で明るいはずか
  if (H) {
    for (let r = 0; r < cells; r++) {
      for (let c = 0; c < cells; c++) {
        const isLight = bits[r * cells + c] > 0;
        for (const dy of [-0.2, 0, 0.2]) {
          for (const dx of [-0.2, 0, 0.2]) {
            const [x, y] = applyH(H, c + 0.5 + dx, r + 0.5 + dy);
            const xi = Math.round(x);
            const yi = Math.round(y);
            if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) continue;
            const i = (yi * img.width + xi) * 4;
            const R = img.data[i];
            const G = img.data[i + 1];
            const B = img.data[i + 2];
            const acc = isLight ? light : dark;
            acc[0] += R;
            acc[1] += G;
            acc[2] += B;
            acc[3] += 0.299 * R + 0.587 * G + 0.114 * B;
            acc[4] += Math.max(R, G, B);
            samples.push({ v: Math.max(R, G, B), light: isLight });
            if (isLight) nl++;
            else nd++;
          }
        }
      }
    }
  }
  const L = light.map((v) => v / Math.max(1, nl));
  const D = dark.map((v) => v / Math.max(1, nd));
  const mid = (L[4] + D[4]) / 2;
  const fit = samples.length ? samples.filter((p) => p.v > mid === p.light).length / samples.length : 0;
  return {
    rgb: [Math.round(L[0]), Math.round(L[1]), Math.round(L[2])],
    contrastGray: nl && nd ? Math.round(L[3] - D[3]) : 0,
    contrastMax: nl && nd ? Math.round(L[4] - D[4]) : 0,
    fit,
  };
}
