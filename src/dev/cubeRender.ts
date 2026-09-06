/**
 * 合成キューブ映像の生成。追跡の数値評価に使う。
 *
 * 既知の3D姿勢からキューブの3面を投影し、正解の面四角形とセル中心を一緒に返す。
 * これがあると「見た感じ動いた」ではなく px 単位の誤差で追跡を評価できる。
 *
 * ここはテスト用であって製品経路には入らない。
 */

import type { Point2D, Quad } from '../tracking/geometry';
import { homographyFromQuad, applyH } from '../tracking/geometry';
import type { Rng } from '../core/cube';

/** 可視3面の識別子。空間面(U/R/F...)への割り当ては UI 側の設定。 */
export type VisibleFaceId = 'U' | 'F' | 'R';

export interface CubePose {
  /** 3D 平行移動。カメラは原点で +Z 方向を向く（Y は画像と同じく下向き） */
  tx: number;
  ty: number;
  tz: number;
  /** ラジアン。X,Y,Z 軸まわり */
  rx: number;
  ry: number;
  rz: number;
  /** キューブの半径（辺長の半分） */
  size: number;
}

export interface Camera3D {
  focal: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export function defaultCamera(width = 480, height = 360): Camera3D {
  return { focal: width * 1.1, cx: width / 2, cy: height / 2, width, height };
}

export function defaultPose(): CubePose {
  // 角が正面に来る標準的な見え方
  return { tx: 0, ty: 0, tz: 9, rx: 0.62, ry: 0.66, rz: 0.04, size: 1 };
}

type Vec3 = [number, number, number];

function rotate(p: Vec3, r: CubePose): Vec3 {
  const [sx, cx] = [Math.sin(r.rx), Math.cos(r.rx)];
  const [sy, cy] = [Math.sin(r.ry), Math.cos(r.ry)];
  const [sz, cz] = [Math.sin(r.rz), Math.cos(r.rz)];
  let [x, y, z] = p;
  // X -> Y -> Z の順
  [y, z] = [y * cx - z * sx, y * sx + z * cx];
  [x, z] = [x * cy + z * sy, -x * sy + z * cy];
  [x, y] = [x * cz - y * sz, x * sz + y * cz];
  return [x, y, z];
}

/** 面の3Dローカル基底。point(u,v) = normal*s + colDir*s*(2u-1) + rowDir*s*(2v-1) */
const FACE_BASIS: Record<VisibleFaceId, { normal: Vec3; colDir: Vec3; rowDir: Vec3 }> = {
  U: { normal: [0, -1, 0], colDir: [1, 0, 0], rowDir: [0, 0, 1] },
  F: { normal: [0, 0, -1], colDir: [1, 0, 0], rowDir: [0, 1, 0] },
  R: { normal: [1, 0, 0], colDir: [0, 0, -1], rowDir: [0, 1, 0] },
};

export const VISIBLE_FACES: VisibleFaceId[] = ['U', 'F', 'R'];

function project(p: Vec3, cam: Camera3D): Point2D {
  return { x: (cam.focal * p[0]) / p[2] + cam.cx, y: (cam.focal * p[1]) / p[2] + cam.cy };
}

function facePoint(id: VisibleFaceId, u: number, v: number, pose: CubePose, cam: Camera3D): Point2D {
  const b = FACE_BASIS[id];
  const s = pose.size;
  const local: Vec3 = [
    b.normal[0] * s + b.colDir[0] * s * (2 * u - 1) + b.rowDir[0] * s * (2 * v - 1),
    b.normal[1] * s + b.colDir[1] * s * (2 * u - 1) + b.rowDir[1] * s * (2 * v - 1),
    b.normal[2] * s + b.colDir[2] * s * (2 * u - 1) + b.rowDir[2] * s * (2 * v - 1),
  ];
  const r = rotate(local, pose);
  return project([r[0] + pose.tx, r[1] + pose.ty, r[2] + pose.tz], cam);
}

export interface GroundTruthFace {
  id: VisibleFaceId;
  quad: Quad;
  /** 9セル中心（facelet index 順 = row-major） */
  cellCenters: Point2D[];
  visible: boolean;
}

/** その姿勢で見える面と、正解の四角形・セル中心を返す。 */
export function groundTruth(pose: CubePose, cam: Camera3D): GroundTruthFace[] {
  return VISIBLE_FACES.map((id) => {
    const b = FACE_BASIS[id];
    const s = pose.size;
    const nWorld = rotate(b.normal, pose);
    const cWorld = rotate([b.normal[0] * s, b.normal[1] * s, b.normal[2] * s], pose);
    const center: Vec3 = [cWorld[0] + pose.tx, cWorld[1] + pose.ty, cWorld[2] + pose.tz];
    // 法線がカメラを向いていれば可視
    const visible = nWorld[0] * center[0] + nWorld[1] * center[1] + nWorld[2] * center[2] < 0;
    const quad: Quad = [
      facePoint(id, 0, 0, pose, cam),
      facePoint(id, 1, 0, pose, cam),
      facePoint(id, 1, 1, pose, cam),
      facePoint(id, 0, 1, pose, cam),
    ];
    const cellCenters: Point2D[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        cellCenters.push(facePoint(id, (c * 2 + 1) / 6, (r * 2 + 1) / 6, pose, cam));
      }
    }
    return { id, quad, cellCenters, visible };
  });
}

// ---------------------------------------------------------------------------
// ラスタライズ
// ---------------------------------------------------------------------------

/** 標準配色に近い6色（sRGB）。 */
const PALETTE: [number, number, number][] = [
  [250, 250, 250], [190, 35, 40], [30, 155, 70], [245, 215, 45], [240, 120, 30], [30, 70, 175],
];

/** 各可視面のステッカー配色（決定的）。実キューブのように単色ではないパターンにする。 */
const STICKERS: Record<VisibleFaceId, number[]> = {
  U: [0, 0, 3, 0, 0, 1, 4, 0, 0],
  F: [2, 2, 2, 5, 2, 2, 2, 3, 2],
  R: [1, 1, 4, 1, 1, 1, 1, 5, 1],
};

export interface RenderOptions {
  /** ステッカー間の黒枠の太さ（正規化面座標） */
  gridWidth?: number;
  /** 背景テクスチャの強さ 0..1。0 だと一様背景 */
  backgroundTexture?: number;
  /** 輝度ノイズの標準偏差 */
  noise?: number;
  /** ボックスぼかし半径（px）。モーションブラーの近似 */
  blur?: number;
  /** 遮蔽矩形（画像座標） */
  occlusion?: { x: number; y: number; w: number; h: number } | null;
  rng?: Rng;
}

export interface RenderedFrame {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  faces: GroundTruthFace[];
}

function boxBlur(rgba: Uint8ClampedArray, w: number, h: number, radius: number): void {
  if (radius < 1) return;
  const src = Uint8ClampedArray.from(rgba);
  const r = Math.round(radius);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const o = (yy * w + xx) * 4;
          sr += src[o]; sg += src[o + 1]; sb += src[o + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      rgba[o] = sr / n;
      rgba[o + 1] = sg / n;
      rgba[o + 2] = sb / n;
    }
  }
}

export function renderFrame(pose: CubePose, cam: Camera3D, opts: RenderOptions = {}): RenderedFrame {
  const w = cam.width;
  const h = cam.height;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const gridWidth = opts.gridWidth ?? 0.045;
  const bgTex = opts.backgroundTexture ?? 0.5;
  const rng = opts.rng;

  // 背景。一様だとオプティカルフローが背景に張り付かないので軽くテクスチャを入れる
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const t = bgTex * 26 * (((x >> 3) + (y >> 3)) % 2 ? 1 : -1);
      const v = 96 + t;
      rgba[o] = v;
      rgba[o + 1] = v + 4;
      rgba[o + 2] = v + 10;
      rgba[o + 3] = 255;
    }
  }

  const faces = groundTruth(pose, cam);
  // 奥の面から描く必要はない（3面は重ならない）が、可視面のみ描く
  for (const f of faces) {
    if (!f.visible) continue;
    const H = homographyFromQuad(f.quad);
    if (!H) continue;
    const inv = (() => {
      const m = H;
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      if (Math.abs(det) < 1e-12) return null;
      const i = new Float64Array(9);
      i[0] = (m[4] * m[8] - m[5] * m[7]) / det;
      i[1] = (m[2] * m[7] - m[1] * m[8]) / det;
      i[2] = (m[1] * m[5] - m[2] * m[4]) / det;
      i[3] = (m[5] * m[6] - m[3] * m[8]) / det;
      i[4] = (m[0] * m[8] - m[2] * m[6]) / det;
      i[5] = (m[2] * m[3] - m[0] * m[5]) / det;
      i[6] = (m[3] * m[7] - m[4] * m[6]) / det;
      i[7] = (m[1] * m[6] - m[0] * m[7]) / det;
      i[8] = (m[0] * m[4] - m[1] * m[3]) / det;
      return i;
    })();
    if (!inv) continue;

    const xs = f.quad.map((p) => p.x);
    const ys = f.quad.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    const p: Point2D = { x: 0, y: 0 };
    const stickers = STICKERS[f.id];

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        applyH(inv, x + 0.5, y + 0.5, p);
        const u = p.x;
        const v = p.y;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        // 黒いステッカー境界（追跡の主要な特徴になる）
        const du = Math.min(u, 1 - u, Math.abs(u - 1 / 3), Math.abs(u - 2 / 3));
        const dv = Math.min(v, 1 - v, Math.abs(v - 1 / 3), Math.abs(v - 2 / 3));
        const o = (y * w + x) * 4;
        if (du < gridWidth || dv < gridWidth) {
          rgba[o] = 18;
          rgba[o + 1] = 18;
          rgba[o + 2] = 20;
          rgba[o + 3] = 255;
          continue;
        }
        const col = Math.min(2, Math.floor(u * 3));
        const row = Math.min(2, Math.floor(v * 3));
        const c = PALETTE[stickers[row * 3 + col]];
        // 面ごとに明るさを変えて陰影をつける（実物に近い）
        const shade = f.id === 'U' ? 1.0 : f.id === 'F' ? 0.86 : 0.72;
        rgba[o] = c[0] * shade;
        rgba[o + 1] = c[1] * shade;
        rgba[o + 2] = c[2] * shade;
        rgba[o + 3] = 255;
      }
    }
  }

  if (opts.occlusion) {
    const { x, y, w: ow, h: oh } = opts.occlusion;
    for (let yy = Math.max(0, y); yy < Math.min(h, y + oh); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(w, x + ow); xx++) {
        const o = (yy * w + xx) * 4;
        rgba[o] = 205;
        rgba[o + 1] = 160;
        rgba[o + 2] = 135;
        rgba[o + 3] = 255;
      }
    }
  }

  if (opts.blur) boxBlur(rgba, w, h, opts.blur);

  if (opts.noise && rng) {
    for (let i = 0; i < w * h; i++) {
      const n = (rng() - 0.5) * 2 * opts.noise;
      const o = i * 4;
      rgba[o] += n;
      rgba[o + 1] += n;
      rgba[o + 2] += n;
    }
  }

  return { rgba, width: w, height: h, faces };
}
