// テスト用のソフトウェアレンダラ：透視投影したキューブの画像を RGBA で作る（OpenCV のテスト用）。
// キュービー単位で描くので、回転途中の層（高速回転の再現）や、連続的な傾き（姿勢推定の試験）も描ける。
import { COLDIR, NORMAL, ORIENTATIONS, ROWDIR, type CubeState, type Vec3, faceletAt, moveAmount, moveFace } from "../src/cube/model";

export type Rgb = [number, number, number];
export const PALETTE: Rgb[] = [
  [235, 235, 235], // U 白
  [200, 20, 40], // R 赤
  [0, 160, 80], // F 緑
  [250, 210, 0], // D 黄
  [255, 110, 0], // L 橙
  [20, 80, 210], // B 青
];

export interface RenderOptions {
  width: number;
  height: number;
  state: CubeState;
  orient: number;
  eye: Vec3;
  target?: Vec3;
  up?: Vec3;
  focal?: number; // px
  gap?: number; // ステッカー間の隙間（キュービー単位）
  palette?: Rgb[];
  noise?: number;
  seed?: number;
  background?: Rgb;
  faceLight?: number[]; // カメラフレームの面ごとの明るさ
  occluders?: { center: [number, number]; radius: number; color: Rgb }[];
  seam?: Rgb; // ステッカーレス: 隙間の色（暗い溝）
  turn?: { move: number; fraction: number }; // 回転途中の層（fraction: 0..1）
  rotation?: readonly number[]; // 姿勢の後にかける連続回転（行優先 3x3）
  offset?: Vec3; // キューブ全体の平行移動（手の揺れ）
}

type Img = { data: Uint8ClampedArray; width: number; height: number };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));
const mat = (m: readonly number[], v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

// 軸 axis（単位ベクトル）まわりに angle（右手系）回す
export function axisAngle(axis: Vec3, angle: number): number[] {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

export function mulMat(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out;
}

function fillPolygon(img: Uint8ClampedArray, w: number, h: number, poly: [number, number][], color: Rgb, light: number) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  if (!Number.isFinite(x0 + x1 + y0 + y1)) return;
  // 向きに依存しない凸多角形の内外判定
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    sign += (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  }
  const s = Math.sign(sign) || 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let inside = true;
      for (let i = 0; i < poly.length && inside; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        if (s * ((b[0] - a[0]) * (y + 0.5 - a[1]) - (b[1] - a[1]) * (x + 0.5 - a[0])) < 0) inside = false;
      }
      if (!inside) continue;
      const k = (y * w + x) * 4;
      img[k] = color[0] * light;
      img[k + 1] = color[1] * light;
      img[k + 2] = color[2] * light;
      img[k + 3] = 255;
    }
  }
}

interface Poly {
  pts: Vec3[];
  color: Rgb;
  light: number;
  depth: number;
}

export function renderCube(o: RenderOptions): Img {
  const { width: w, height: h } = o;
  const img = new Uint8ClampedArray(w * h * 4);
  const bg = o.background ?? [90, 80, 70];
  let seed = o.seed ?? 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < w * h; i++) {
    const y = Math.floor(i / w);
    const g = 0.8 + (0.4 * y) / h;
    img[i * 4] = bg[0] * g;
    img[i * 4 + 1] = bg[1] * g;
    img[i * 4 + 2] = bg[2] * g;
    img[i * 4 + 3] = 255;
  }
  const target = o.target ?? [0, 0, 0];
  const fwd = norm(sub(target, o.eye));
  const right = norm(cross(fwd, o.up ?? [0, 1, 0]));
  const upv = cross(right, fwd);
  const f = o.focal ?? w * 1.1;
  const project = (p: Vec3): [number, number] => {
    const d = sub(p, o.eye);
    const zc = dot(d, fwd);
    return [w / 2 + (f * dot(d, right)) / zc, h / 2 - (f * dot(d, upv)) / zc];
  };
  const palette = o.palette ?? PALETTE;
  const gap = o.gap ?? 0.07;
  const light = o.faceLight ?? [1, 0.8, 0.9, 0.6, 0.75, 0.7];
  const world = o.rotation ? mulMat(o.rotation, ORIENTATIONS[o.orient]) : [...ORIENTATIONS[o.orient]];
  const offset = o.offset ?? [0, 0, 0];
  const turnFace = o.turn ? moveFace(o.turn.move) : -1;
  const turnRot = o.turn ? axisAngle(NORMAL[turnFace], (-Math.PI / 2) * moveAmount(o.turn.move) * o.turn.fraction) : null;
  const toWorld = (p: Vec3, inTurn: boolean): Vec3 => add(mat(world, inTurn && turnRot ? mat(turnRot, p) : p), offset);
  const lightOf = (n: Vec3) => {
    const a = n.map(Math.abs);
    const k = a[0] > a[1] && a[0] > a[2] ? (n[0] > 0 ? 1 : 4) : a[1] > a[2] ? (n[1] > 0 ? 0 : 3) : n[2] > 0 ? 2 : 5;
    return light[k];
  };

  const polys: Poly[] = [];
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        const p: Vec3 = [x, y, z];
        const inTurn = turnFace >= 0 && dot(p, NORMAL[turnFace]) === 1;
        for (let fi = 0; fi < 6; fi++) {
          const n = NORMAL[fi];
          const rd = ROWDIR[fi];
          const cd = COLDIR[fi];
          const nW = sub(toWorld(add(p, n), inTurn), toWorld(p, inTurn));
          const center = add(p, scale(n, 0.49));
          const cW = toWorld(center, inTurn);
          if (dot(nW, sub(o.eye, cW)) <= 0) continue;
          const quad = (c: Vec3, hs: number) => [add(c, add(scale(rd, -hs), scale(cd, -hs))), add(c, add(scale(rd, -hs), scale(cd, hs))), add(c, add(scale(rd, hs), scale(cd, hs))), add(c, add(scale(rd, hs), scale(cd, -hs)))].map((q) => toWorld(q as Vec3, inTurn));
          const depth = Math.hypot(...sub(cW, o.eye));
          polys.push({ pts: quad(center, 0.49), color: o.seam ?? [18, 18, 18], light: 1, depth });
          if (dot(p, n) === 1) {
            const color = palette[o.state[faceletAt(p, n)]];
            polys.push({ pts: quad(add(p, scale(n, 0.495)), 0.5 - gap), color, light: lightOf(nW), depth: depth - 0.001 });
          }
        }
      }
  polys.sort((a, b) => b.depth - a.depth);
  for (const pl of polys) fillPolygon(img, w, h, pl.pts.map(project), pl.color, pl.light);

  for (const oc of o.occluders ?? []) {
    const poly: [number, number][] = Array.from({ length: 16 }, (_, i) => [
      oc.center[0] + oc.radius * Math.cos((i * Math.PI) / 8),
      oc.center[1] + oc.radius * Math.sin((i * Math.PI) / 8),
    ]);
    fillPolygon(img, w, h, poly, oc.color, 1);
  }
  const noise = o.noise ?? 6;
  for (let i = 0; i < w * h * 4; i++) {
    if ((i & 3) === 3) continue;
    img[i] = img[i] + (rnd() - 0.5) * 2 * noise;
  }
  return { data: img, width: w, height: h };
}

// 露光中の動き（モーションブラー）: 複数の瞬間の画像を平均する
export function averageImages(imgs: Img[]): Img {
  const out = new Uint8ClampedArray(imgs[0].data.length);
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (const im of imgs) s += im.data[i];
    out[i] = s / imgs.length;
  }
  return { data: out, width: imgs[0].width, height: imgs[0].height };
}
