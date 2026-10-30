// テスト用の描画の部品: 指（肌色のカプセル）・回転行列・印刷した 4×4 の 54 種類のステッカーの色。
// ArUco ステッカーのキューブの合成画像（tests/arucoCube.ts）で使う
import type { Vec3 } from "../src/cube/model";

export type Rgb = [number, number, number];
// 最初に印刷した 4×4 の 54 種類のステッカーの色（3×3 の符号は src/aruco/palette.ts の PRINT_COLORS）
export const PALETTE: Rgb[] = [
  [235, 235, 235], // U 白
  [200, 20, 40], // R 赤
  [0, 160, 80], // F 緑
  [250, 210, 0], // D 黄
  [255, 110, 0], // L 橙
  [20, 80, 210], // B 青
];

export interface Finger {
  a: [number, number]; // 付け根側
  b: [number, number]; // 指先
  width: number;
  color?: Rgb;
}

// 指のカプセルを囲む多角形（手の検出のマスクに使う）
export function fingerPolygon(fg: Finger, grow = 1): [number, number][] {
  const r = (fg.width / 2) * grow;
  const dx = fg.b[0] - fg.a[0];
  const dy = fg.b[1] - fg.a[1];
  const ang = Math.atan2(dy, dx);
  const pts: [number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const t = ang - Math.PI / 2 + (Math.PI * i) / 8;
    pts.push([fg.b[0] + r * Math.cos(t), fg.b[1] + r * Math.sin(t)]);
  }
  for (let i = 0; i <= 8; i++) {
    const t = ang + Math.PI / 2 + (Math.PI * i) / 8;
    pts.push([fg.a[0] + r * Math.cos(t), fg.a[1] + r * Math.sin(t)]);
  }
  return pts;
}

// 点 (x, y) から指の芯（線分 a–b）までの距離
export function fingerDistance(fg: Finger, x: number, y: number): number {
  const dx = fg.b[0] - fg.a[0];
  const dy = fg.b[1] - fg.a[1];
  const len = Math.hypot(dx, dy) || 1;
  const t = Math.max(0, Math.min(1, ((x - fg.a[0]) * dx + (y - fg.a[1]) * dy) / (len * len)));
  return Math.hypot(x - (fg.a[0] + dx * t), y - (fg.a[1] + dy * t));
}

// 指: 肌色のカプセル。幅方向に陰影をつける。img は 1 画素 stride 個（RGB を先頭に）
export function paintFingers(img: { [i: number]: number }, w: number, h: number, fingers: Finger[], stride = 4): void {
  for (const fg of fingers) {
    const col = fg.color ?? [222, 170, 140];
    const poly = fingerPolygon(fg);
    const xs = poly.map((q) => q[0]);
    const ys = poly.map((q) => q[1]);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(h - 1, Math.ceil(Math.max(...ys))); y++)
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(w - 1, Math.ceil(Math.max(...xs))); x++) {
        const dist = fingerDistance(fg, x, y);
        if (dist > fg.width / 2) continue;
        const shade = 0.75 + 0.35 * Math.sqrt(Math.max(0, 1 - (dist / (fg.width / 2)) ** 2));
        const k = (y * w + x) * stride;
        img[k] = col[0] * shade;
        img[k + 1] = col[1] * shade;
        img[k + 2] = col[2] * shade;
      }
  }
}

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
