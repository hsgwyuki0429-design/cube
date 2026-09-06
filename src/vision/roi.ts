/**
 * ROI（関心領域）の定義とセルのサンプリング点生成。
 *
 * 自動キューブ検出はフェーズ0のスコープ外（CLAUDE.md「やらないこと」）。
 * 4隅ドラッグ + ホモグラフィで 3x3 をサンプリングする。
 */

import { computeHomography, mapPoint, isConvexQuad, type Pt, type Homography } from './homography';
import { FACE_NAMES, type FaceIndex } from '../core/cube';

/** 4隅は正規化画像座標 (0..1)。順に facelet (0,0) / (0,2) / (2,2) / (2,0) に対応する。 */
export type Corners = [Pt, Pt, Pt, Pt];

export interface RoiConfig {
  id: string;
  /** この ROI に映っている空間面。カメラは固定なので実行中に変わらない。 */
  face: FaceIndex;
  corners: Corners;
  /** facelet グリッドの回転オフセット（90度単位）。見え方に合わせて UI から切り替える。 */
  rotate: 0 | 1 | 2 | 3;
  /** 鏡像フラグ。通常は false（外側から見ているので）。逃げ道として用意。 */
  mirror: boolean;
  enabled: boolean;
}

export const DEFAULT_SAMPLES_PER_AXIS = 4;

/** セル数 x 軸方向サンプル数。中央50%領域を samplesPerAxis^2 点で平均する。 */
export const CELL_COUNT = 9;

function defaultCorners(cx: number, cy: number, half: number): Corners {
  return [
    { x: cx - half, y: cy - half },
    { x: cx + half, y: cy - half },
    { x: cx + half, y: cy + half },
    { x: cx - half, y: cy + half },
  ];
}

/**
 * 既定の2枚。CLAUDE.md の通り 1面では候補の判別能力が足りないため必ず2枚使う。
 * 既定は F（前面）と U（上面）。
 */
export function defaultRois(): RoiConfig[] {
  return [
    { id: 'roi0', face: 2 as FaceIndex, corners: defaultCorners(0.35, 0.6, 0.16), rotate: 0, mirror: false, enabled: true },
    { id: 'roi1', face: 0 as FaceIndex, corners: defaultCorners(0.68, 0.35, 0.14), rotate: 0, mirror: false, enabled: true },
  ];
}

/** ROI を1枚足す。固定カメラで見えるのは最大3面なので上限は3。 */
export function makeRoi(id: string, face: FaceIndex): RoiConfig {
  return { id, face, corners: defaultCorners(0.5, 0.5, 0.13), rotate: 0, mirror: false, enabled: true };
}

export const MAX_ROIS = 3;

export function roiLabel(r: RoiConfig): string {
  return `${r.id} → ${FACE_NAMES[r.face]}`;
}

/**
 * facelet 座標 (row, col) を ROI グリッド座標へ変換する。
 * mirror を先に、その後 rotate を適用。
 */
export function orientCell(row: number, col: number, rotate: number, mirror: boolean): [number, number] {
  let r = row;
  let c = mirror ? 2 - col : col;
  for (let k = 0; k < ((rotate % 4) + 4) % 4; k++) {
    const nr = c;
    const nc = 2 - r;
    r = nr;
    c = nc;
  }
  return [r, c];
}

/**
 * 各セルのサンプリング点（正規化画像座標）を返す。
 * 返り値は Float32Array(9 * k*k * 2)。facelet index の昇順、その中は行優先。
 */
export function cellSamplePoints(
  roi: RoiConfig,
  samplesPerAxis = DEFAULT_SAMPLES_PER_AXIS,
): Float32Array {
  const H = computeHomography(roi.corners);
  const k = samplesPerAxis;
  const out = new Float32Array(CELL_COUNT * k * k * 2);
  const p: Pt = { x: 0, y: 0 };
  let w = 0;
  for (let i = 0; i < CELL_COUNT; i++) {
    const [gr, gc] = orientCell(Math.floor(i / 3), i % 3, roi.rotate, roi.mirror);
    for (let sy = 0; sy < k; sy++) {
      // 中央50%領域: セル内の 0.25 .. 0.75
      const v = (gr + 0.25 + (0.5 * (sy + 0.5)) / k) / 3;
      for (let sx = 0; sx < k; sx++) {
        const u = (gc + 0.25 + (0.5 * (sx + 0.5)) / k) / 3;
        mapPoint(H, u, v, p);
        out[w++] = p.x;
        out[w++] = p.y;
      }
    }
  }
  return out;
}

/** グリッド線の描画用に、ROI 内の (u,v) 格子を画像座標へ写す。 */
export function gridPoints(corners: Corners, divisions = 3): Pt[][] {
  const H: Homography = computeHomography(corners);
  const rows: Pt[][] = [];
  for (let i = 0; i <= divisions; i++) {
    const row: Pt[] = [];
    for (let j = 0; j <= divisions; j++) row.push(mapPoint(H, j / divisions, i / divisions));
    rows.push(row);
  }
  return rows;
}

/** セル中心（表示用）。facelet index 順。 */
export function cellCenters(roi: RoiConfig): Pt[] {
  const H = computeHomography(roi.corners);
  const out: Pt[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const [gr, gc] = orientCell(Math.floor(i / 3), i % 3, roi.rotate, roi.mirror);
    out.push(mapPoint(H, (gc + 0.5) / 3, (gr + 0.5) / 3));
  }
  return out;
}

/** セルの四隅（塗りつぶし用）。facelet index 順。 */
export function cellQuads(roi: RoiConfig): Corners[] {
  const H = computeHomography(roi.corners);
  const out: Corners[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const [gr, gc] = orientCell(Math.floor(i / 3), i % 3, roi.rotate, roi.mirror);
    const u0 = gc / 3;
    const u1 = (gc + 1) / 3;
    const v0 = gr / 3;
    const v1 = (gr + 1) / 3;
    out.push([
      mapPoint(H, u0, v0),
      mapPoint(H, u1, v0),
      mapPoint(H, u1, v1),
      mapPoint(H, u0, v1),
    ]);
  }
  return out;
}

export function validateRoi(roi: RoiConfig): string | null {
  if (!isConvexQuad(roi.corners)) return '四隅がねじれています（凸四角形にしてください）';
  const area = Math.abs(
    roi.corners.reduce((acc, p, i) => {
      const q = roi.corners[(i + 1) % 4];
      return acc + (p.x * q.y - q.x * p.y);
    }, 0) / 2,
  );
  if (area < 0.002) return 'ROI が小さすぎます';
  return null;
}

// ---------------------------------------------------------------------------
// 永続化
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'cubevision.rois.v1';

export function loadRois(): RoiConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultRois();
    const parsed = JSON.parse(raw) as RoiConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultRois();
    const base = defaultRois();
    return parsed.slice(0, MAX_ROIS).map((r, i) => ({
      ...(base[i] ?? makeRoi(`roi${i}`, 1 as FaceIndex)),
      ...r,
      corners: r.corners.map((c) => ({ x: c.x, y: c.y })) as Corners,
    }));
  } catch {
    return defaultRois();
  }
}

export function saveRois(rois: RoiConfig[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rois));
  } catch {
    /* localStorage 不可でも動作は継続する */
  }
}
