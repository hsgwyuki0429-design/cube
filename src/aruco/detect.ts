// 色付き ArUco マーカーの検出（OpenCV.js の ArucoDetector）。DOM もカメラも知らない（Node でも動く）。
// マーカーの「白」のセルをステッカーの色に置き換えているので、前処理を切り替えて比べる:
//   gray … 普通のグレースケール。青・赤のセルは暗くなり黒との差が小さい
//   max  … max(R,G,B)（HSV の V）。色付きのセルも明るく残る
import { type Pt, applyH, fitHomography } from "../vision/homography";
import type { CV } from "../vision/quads";
import { type StickerScheme, makeDictionary, markerBits, markerSize } from "./codes";

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

// 1 フレームに複数の方式を順に当てる。Mat は使い回す
export class ArucoBench {
  private dict: any;
  private detectors: any[];
  private cells: number; // マーカーの枠を含むマスの数（4×4 の符号なら 6）
  private rgba: any = null;
  private gray: any = null;
  private max: any = null;

  constructor(
    private cv: CV,
    readonly configs: DetectorConfig[],
    readonly scheme: StickerScheme = "aruco54",
  ) {
    this.dict = makeDictionary(cv, scheme);
    this.cells = markerSize(scheme) + 2;
    this.detectors = configs.map((c) => {
      const p = new cv.aruco_DetectorParameters();
      for (const k of PARAM_KEYS) {
        const v = c.params[k];
        if (typeof v === "number" && Number.isFinite(v)) p[k] = v;
      }
      const det = new cv.aruco_ArucoDetector(this.dict, p, new cv.aruco_RefineParameters(10, 3, true));
      p.delete();
      return det;
    });
  }

  detect(img: ImageLike): DetectResult[] {
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
          markers.push(this.describe(img, id, c));
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

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function maxChannel(src: Uint8ClampedArray | Uint8Array, dst: Uint8Array): void {
  for (let i = 0, j = 0; j < dst.length; i += 4, j++) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    dst[j] = r > g ? (r > b ? r : b) : g > b ? g : b;
  }
}

// マーカーのセルの中心付近（3×3 点）を読み、明るいセルの色と、明るいセル − 黒いセルの差を出す
// bits: 枠を含む cells×cells（1 = 明るい）
export function measureCells(img: ImageLike, corners: Pt[], bits: Uint8Array, cells = 6): Pick<Marker, "rgb" | "contrastGray" | "contrastMax"> {
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
            if (isLight) nl++;
            else nd++;
          }
        }
      }
    }
  }
  const L = light.map((v) => v / Math.max(1, nl));
  const D = dark.map((v) => v / Math.max(1, nd));
  return {
    rgb: [Math.round(L[0]), Math.round(L[1]), Math.round(L[2])],
    contrastGray: nl && nd ? Math.round(L[3] - D[3]) : 0,
    contrastMax: nl && nd ? Math.round(L[4] - D[4]) : 0,
  };
}
