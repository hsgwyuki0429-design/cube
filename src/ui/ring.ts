// 円環図の幾何（jagarikin さんの「円でできたルービックキューブ」の図と同じ考え方）。DOM を持たない（tests/ring.test.ts で検証）。
//
// 層（3 軸 × 3 層 = 9 本）ごとに、その層の側面の 12 枚が 1 つの円の上に並ぶ。各ステッカーは、自分の面に垂直でない 2 軸の層の円の
// 交わるところに置く。面を回すと、その層の円に沿ってステッカーが 3 つずつ進む（回した面そのものの 8 枚は、その面のセンターのまわりを回る）。
//
// 作り方: 各ステッカーを球面上に置く。面の法線の軸 c・符号 s、他の 2 軸 a・b の位置 pa・pb（-1, 0, 1）のステッカーを
//   q[a] = K·pa、q[b] = K·pb、q[c] = s·√(1 − K²(pa² + pb²))
// とすると、層（軸 a・位置 l）の 12 枚はどれも q[a] = K·l の平面の上 = 球面上の 1 つの円の上にある。これを立体射影（円を円に写す）で
// 平面に写す。射影の中心は B・L・D の角の向き（U・R・F の角から見る）なので、U・R・F が真ん中に 3 つの花びらのように並び、
// B・L・D の層の円は外側の大きな円になる。射影の中心の近く（B・L・D の角）はとても遠くに写るので、中心からの距離だけを
// r → r / (1 + r / COMPRESS) で縮める（円はわずかにゆがむ。層の円は球面上の円をそのまま写した曲線で描くので、点は必ず線の上にある）
import { FACES, MOVE_DEST, NORMAL, faceletGeometry, moveAmount, moveFace } from "../cube/model";

const K = 0.45; // 球面上の格子の間隔（大きいほど面の 9 枚が広がる）
const COMPRESS = 2; // 中心からの距離の縮め方
type V3 = [number, number, number];

// 球面上の位置
function spherePoint(f: number): V3 {
  const { pos, normal } = faceletGeometry(f);
  const c = normal.findIndex((v) => v !== 0);
  const q: V3 = [0, 0, 0];
  let s2 = 0;
  for (let k = 0; k < 3; k++) {
    if (k === c) continue;
    q[k] = K * pos[k];
    s2 += q[k] * q[k];
  }
  q[c] = normal[c] * Math.sqrt(1 - s2);
  return q;
}

const unit = (v: V3): V3 => {
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// 立体射影: 中心 POLE（B・L・D の角の向き）から、POLE に垂直な平面へ。画面の上 = U の向き、右 = R の側
const POLE = unit([-1, -1, -1]);
const UP = unit([0, 1, 0].map((v, i) => v - dot([0, 1, 0], POLE) * POLE[i]) as V3);
const RIGHT = cross(POLE, UP);
function project(q: V3): [number, number] {
  const d = Math.max(1e-6, 1 - dot(q, POLE));
  const x = dot(q, RIGHT) / d;
  const y = -dot(q, UP) / d; // 画面は y が下
  const r = Math.hypot(x, y);
  const k = r > 0 ? 1 / (1 + r / COMPRESS) : 1;
  return [x * k, y * k];
}

const RAW = Array.from({ length: 54 }, (_, f) => project(spherePoint(f)));
// 54 個の点が半径 1 の中に入るように縮める
const SCALE = 1 / Math.max(...RAW.map(([x, y]) => Math.hypot(x, y)));

// 各ステッカーの位置（図の中心 = 原点、点はすべて半径 1 以内。x 右・y 下）
export const RING_POINTS: [number, number][] = RAW.map(([x, y]) => [x * SCALE, y * SCALE]);

export interface RingCircle {
  axis: number; // 0 x / 1 y / 2 z
  layer: number; // -1, 0, 1
  points: [number, number][]; // 円を写した閉じた曲線（RING_SAMPLES 点。点 i は球面上の円の角度 2πi/RING_SAMPLES）
  facelets: number[]; // この円の上のステッカー（12 枚）
}

export const RING_SAMPLES = 180;

// 9 本の層の円（球面上の円 q[axis] = K·layer を写した曲線）
export const RING_CIRCLES: RingCircle[] = [0, 1, 2].flatMap((axis) =>
  [-1, 0, 1].map((layer) => {
    const facelets = Array.from({ length: 54 }, (_, f) => f).filter((f) => {
      const { pos, normal } = faceletGeometry(f);
      return normal[axis] === 0 && pos[axis] === layer;
    });
    const h = K * layer;
    const rr = Math.sqrt(1 - h * h);
    const [u, v] = [0, 1, 2].filter((k) => k !== axis);
    const pt = (t: number): [number, number] => {
      const q: V3 = [0, 0, 0];
      q[axis] = h;
      q[u] = rr * Math.cos(t);
      q[v] = rr * Math.sin(t);
      const [x, y] = project(q);
      return [x * SCALE, y * SCALE];
    };
    return { axis, layer, points: Array.from({ length: RING_SAMPLES }, (_, i) => pt((2 * Math.PI * i) / RING_SAMPLES)), facelets };
  }),
);

// 層の円の上でのステッカーの位置（球面上の円の角度、0〜2π）
export function ringAngle(rc: RingCircle, f: number): number {
  const q = spherePoint(f);
  const [u, v] = [0, 1, 2].filter((k) => k !== rc.axis);
  return (Math.atan2(q[v], q[u]) + 2 * Math.PI) % (2 * Math.PI);
}

// 層の円の角度 a0 から a1 まで（dir: 1 = 角度が増える向き）の曲線（画面の座標、scale 倍・中心 (cx, cy)）
export function ringArc(rc: RingCircle, a0: number, a1: number, dir: number): [number, number][] {
  let span = dir > 0 ? a1 - a0 : a0 - a1;
  while (span < 0) span += 2 * Math.PI;
  const n = Math.max(2, Math.ceil((span / (2 * Math.PI)) * RING_SAMPLES));
  const [u, v] = [0, 1, 2].filter((k) => k !== rc.axis);
  const h = K * rc.layer;
  const rr = Math.sqrt(1 - h * h);
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = a0 + (dir > 0 ? 1 : -1) * (span * i) / n;
    const q: V3 = [0, 0, 0];
    q[rc.axis] = h;
    q[u] = rr * Math.cos(t);
    q[v] = rr * Math.sin(t);
    const [x, y] = project(q);
    return [x * SCALE, y * SCALE];
  });
}

// 手 move で、層の軸のまわりに球面上の円の角度が増える向きに回るか（1）減る向きか（-1）
export function ringDirection(move: number): number {
  const face = moveFace(move);
  const n = NORMAL[face];
  const axis = n.findIndex((v) => v !== 0);
  // 時計回り（外から見て）= 外向きの法線のまわりに負。角度は u→v の向き（u < v の 2 軸）: x 軸（y→z）と z 軸（x→y）は軸の正の向きの
  // まわりの右手の回転、y 軸（x→z）は逆向き
  const sign = moveAmount(move) === 3 ? 1 : -1;
  return sign * n[axis] * (axis === 1 ? -1 : 1);
}

// 面 face を回したとき、側面の 12 枚が進む円
export function turnCircle(face: number): RingCircle {
  const n = NORMAL[face];
  const axis = n.findIndex((v) => v !== 0);
  return RING_CIRCLES.find((c) => c.axis === axis && c.layer === n[axis])!;
}

// 手 move で動くステッカーの移動（元の facelet → 行き先）
export function moveArrows(move: number): { from: number; to: number }[] {
  const dest = MOVE_DEST[move];
  const out: { from: number; to: number }[] = [];
  for (let f = 0; f < 54; f++) if (dest[f] !== f) out.push({ from: f, to: dest[f] });
  return out;
}

// 手 move で facelet f の点が動き始める向き（図の上の小さな移動）。球面上で層の軸のまわりに少し回して写す
export function startDirection(f: number, move: number): [number, number] {
  const n = NORMAL[moveFace(move)] as V3;
  const angle = (moveAmount(move) === 3 ? 1 : -1) * 0.05; // 時計回り = 外向きの法線のまわりに負
  const q = spherePoint(f);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kxq = cross(n, q);
  const d = dot(n, q);
  const r: V3 = [0, 1, 2].map((i) => q[i] * c + kxq[i] * s + n[i] * d * (1 - c)) as V3;
  const [x0, y0] = RING_POINTS[f];
  const [x1, y1] = project(r);
  return [x1 * SCALE - x0, y1 * SCALE - y0];
}

export const FACE_CENTER = (face: number) => face * 9 + 4;
export { FACES };
