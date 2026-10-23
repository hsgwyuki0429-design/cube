// テスト用のソフトウェアレンダラ：透視投影したキューブの画像を RGBA で作る（OpenCV のテスト用）
import { COLDIR, NORMAL, ROWDIR, VIEW, type CubeState, type Vec3 } from "../src/cube/model";

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
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));

function fillPolygon(img: Uint8ClampedArray, w: number, h: number, poly: [number, number][], color: Rgb, light: number) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
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

export function renderCube(o: RenderOptions): { data: Uint8ClampedArray; width: number; height: number } {
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
  for (let c = 0; c < 6; c++) {
    const n = NORMAL[c];
    const faceCenter = scale(n, 1.5);
    if (dot(n, sub(o.eye, faceCenter)) <= 0) continue;
    const rd = ROWDIR[c];
    const cd = COLDIR[c];
    const corner = (r: number, s: number): Vec3 => add(faceCenter, add(scale(rd, r), scale(cd, s)));
    fillPolygon(img, w, h, [corner(-1.5, -1.5), corner(-1.5, 1.5), corner(1.5, 1.5), corner(1.5, -1.5)].map(project), [18, 18, 18], 1);
    for (let cell = 0; cell < 9; cell++) {
      const row = Math.floor(cell / 3) - 1;
      const col = (cell % 3) - 1;
      const hs = 0.5 - gap;
      const pts = [corner(row - hs, col - hs), corner(row - hs, col + hs), corner(row + hs, col + hs), corner(row + hs, col - hs)].map(project);
      const color = palette[o.state[VIEW[(o.orient * 6 + c) * 9 + cell]]];
      fillPolygon(img, w, h, pts, color, light[c]);
    }
  }
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
