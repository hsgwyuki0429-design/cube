// ArUco ステッカーを貼ったキューブの合成画像（テスト用）。ステッカーは駒と一緒に動くので、色だけでなく
// どのステッカーがどの向きで貼られているか（ID と上向き）を 3D で追う。画素ごとに視線と面の交点を求めて描く。
import { FACE_TURN, NORMAL, ORIENTATIONS, ROWDIR, type Vec3, apply, faceletAt, faceletGeometry, moveAmount, moveFace } from "../src/cube/model";
import type { CV } from "../src/vision/quads";
import { PALETTE, axisAngle, mulMat } from "./render";

export interface Sticker {
  id: number; // 揃った状態での facelet 番号
  pos: Vec3; // キュービーの位置（キューブ固定フレーム）
  normal: Vec3;
  up: Vec3; // マーカーの上辺の向き
}

// 揃った状態: マーカーの上辺はその面の「上」（行 0 の側 = -ROWDIR）
export function solvedStickers(): Sticker[] {
  return Array.from({ length: 54 }, (_, id) => {
    const g = faceletGeometry(id);
    const f = Math.floor(id / 9);
    return { id, pos: g.pos, normal: g.normal, up: ROWDIR[f].map((v) => -v) as Vec3 };
  });
}

export function applyMoveStickers(st: Sticker[], move: number): Sticker[] {
  const f = moveFace(move);
  let m = FACE_TURN[f];
  for (let k = 1; k < moveAmount(move); k++) m = mulMat(FACE_TURN[f], m);
  return st.map((s) => {
    const p = s.pos;
    if (p[0] * NORMAL[f][0] + p[1] * NORMAL[f][1] + p[2] * NORMAL[f][2] !== 1) return s;
    return { ...s, pos: apply(m, s.pos), normal: apply(m, s.normal), up: apply(m, s.up) };
  });
}

// facelet 番号 → そこにあるステッカーの ID
export function stickerAt(st: Sticker[]): number[] {
  const out = new Array(54).fill(-1);
  for (const s of st) out[faceletAt(s.pos, s.normal)] = s.id;
  return out;
}

export interface CubeRenderOptions {
  width: number;
  height: number;
  stickers: Sticker[];
  orient: number;
  eye: Vec3;
  target?: Vec3;
  focal?: number;
  turn?: { move: number; fraction: number; spread?: number }; // spread: 露光中に進む割合（ぶれ）
  background?: [number, number, number];
  noise?: number;
  seed?: number;
  sticker?: number; // ステッカーの辺（キュービー = 1）
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dotv = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => scl(a, 1 / Math.hypot(...a));
const matv = (m: readonly number[], v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

const bitsCache = new Map<number, Uint8Array>();
function bitsOf(cv: CV, id: number): Uint8Array {
  let b = bitsCache.get(id);
  if (!b) {
    const d = cv.getPredefinedDictionary(cv.DICT_4X4_100);
    const m = new cv.Mat();
    cv.generateImageMarker(d, id, 6, m, 1);
    b = new Uint8Array(m.data);
    m.delete();
    d.delete();
    bitsCache.set(id, b);
  }
  return b;
}

interface Quad {
  p0: Vec3; // 左上
  a: Vec3; // 右へ（辺の長さ）
  b: Vec3; // 下へ
  n: Vec3;
  sticker?: Sticker;
  light: number;
}

export function renderArucoCube(cv: CV, o: CubeRenderOptions): { data: Uint8ClampedArray; width: number; height: number } {
  const { width: w, height: h } = o;
  const spread = o.turn?.spread ?? 0;
  const subs = o.turn && spread > 0 ? 3 : 1;
  const acc = new Float32Array(w * h * 3);
  for (let s = 0; s < subs; s++) {
    const fraction = o.turn ? o.turn.fraction + (subs > 1 ? (s / (subs - 1) - 0.5) * spread : 0) : 0;
    const img = renderOnce(cv, o, fraction);
    for (let i = 0; i < acc.length; i++) acc[i] += img[i] / subs;
  }
  let seed = o.seed ?? 1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = acc[i * 3 + c] + (o.noise ? gauss() * o.noise : 0);
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

function renderOnce(cv: CV, o: CubeRenderOptions, fraction: number): Float32Array {
  const { width: w, height: h } = o;
  const bg = o.background ?? [70, 66, 62];
  const out = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) out.set(bg, i * 3);
  const target = o.target ?? [0, 0, 0];
  const fwd = norm(sub(target, o.eye));
  const right = norm(cross(fwd, [0, 1, 0]));
  const upv = cross(right, fwd);
  const f = o.focal ?? Math.max(w, h) * 0.8; // スマホの標準カメラ（画角 65° 前後）
  const world = ORIENTATIONS[o.orient];
  const turnFace = o.turn ? moveFace(o.turn.move) : -1;
  const turnRot = o.turn ? axisAngle(NORMAL[turnFace], (-Math.PI / 2) * moveAmount(o.turn.move) * fraction) : null;
  const inTurn = (p: Vec3) => turnFace >= 0 && dotv(p, NORMAL[turnFace]) === 1;
  const toWorld = (v: Vec3, turning: boolean): Vec3 => matv(world, turning && turnRot ? matv(turnRot, v) : v);
  const lightOf = (n: Vec3) => 0.72 + 0.28 * Math.max(0, dotv(n, norm([0.3, 0.8, 0.5])));
  const quads: Quad[] = [];
  // 黒い本体: 各キュービーの外向きの面（隙間から見える内側の面も含め、カメラを向く面すべて）
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        const p: Vec3 = [x, y, z];
        const t = inTurn(p);
        for (let fi = 0; fi < 6; fi++) {
          const n = NORMAL[fi];
          const nW = toWorld(n, t);
          const c = toWorld(addv(p, scl(n, 0.5)), t);
          if (dotv(nW, sub(o.eye, c)) <= 0) continue;
          // 面内の 2 軸
          const ax: Vec3 = Math.abs(n[1]) === 1 ? [1, 0, 0] : [0, 1, 0];
          const bx = cross(n, ax);
          const aW = toWorld(ax, t);
          const bW = toWorld(bx, t);
          quads.push({ p0: sub(sub(c, scl(aW, 0.5)), scl(bW, 0.5)), a: aW, b: bW, n: nW, light: 1 });
        }
      }
  const half = (o.sticker ?? 0.94) / 2;
  for (const s of o.stickers) {
    const t = inTurn(s.pos);
    const rightS = cross(s.up, s.normal);
    const c = toWorld(addv(s.pos, scl(s.normal, 0.502)), t);
    const nW = toWorld(s.normal, t);
    if (dotv(nW, sub(o.eye, c)) <= 0) continue;
    const aW = toWorld(scl(rightS, 2 * half), t);
    const bW = toWorld(scl(s.up, -2 * half), t);
    quads.push({ p0: sub(sub(c, scl(aW, 0.5)), scl(bW, 0.5)), a: aW, b: bW, n: nW, sticker: s, light: lightOf(nW) });
  }
  const project = (p: Vec3): [number, number] => {
    const d = sub(p, o.eye);
    const zc = dotv(d, fwd);
    return [w / 2 + (f * dotv(d, right)) / zc, h / 2 - (f * dotv(d, upv)) / zc];
  };
  const SS = 2; // 2×2 のサブピクセル
  const sub2 = new Float32Array(w * h * SS * SS * 3);
  const zsub = new Float32Array(w * h * SS * SS).fill(Number.POSITIVE_INFINITY);
  for (const q of quads) {
    const pts = [q.p0, addv(q.p0, q.a), addv(addv(q.p0, q.a), q.b), addv(q.p0, q.b)].map(project);
    const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0]))));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(...pts.map((p) => p[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(...pts.map((p) => p[1]))));
    const aa = dotv(q.a, q.a);
    const bb = dotv(q.b, q.b);
    const bits = q.sticker ? bitsOf(cv, q.sticker.id) : null;
    const color = q.sticker ? PALETTE[Math.floor(q.sticker.id / 9)] : [20, 20, 22];
    const black = [24, 24, 26];
    const pn = dotv(q.n, sub(q.p0, o.eye));
    // 視線 d = fwd + right·sx + upv·sy（sx, sy は画素から決まる）。内側のループはスカラーで
    const [nx, ny, nz] = q.n;
    const nf = nx * fwd[0] + ny * fwd[1] + nz * fwd[2];
    const nr = nx * right[0] + ny * right[1] + nz * right[2];
    const nu = nx * upv[0] + ny * upv[1] + nz * upv[2];
    const ex = o.eye[0] - q.p0[0];
    const ey = o.eye[1] - q.p0[1];
    const ez = o.eye[2] - q.p0[2];
    const m = 0.08;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (let sy = 0; sy < SS; sy++) {
          const fy = -(y + (sy + 0.5) / SS - h / 2) / f;
          for (let sx = 0; sx < SS; sx++) {
            const fx = (x + (sx + 0.5) / SS - w / 2) / f;
            const den = nf + nr * fx + nu * fy;
            if (Math.abs(den) < 1e-9) continue;
            const t = pn / den;
            if (t <= 0) continue;
            const k = (y * w + x) * SS * SS + sy * SS + sx;
            if (t >= zsub[k]) continue;
            const dx = fwd[0] + right[0] * fx + upv[0] * fy;
            const dy = fwd[1] + right[1] * fx + upv[1] * fy;
            const dz = fwd[2] + right[2] * fx + upv[2] * fy;
            const hx = ex + dx * t;
            const hy = ey + dy * t;
            const hz = ez + dz * t;
            const u = (hx * q.a[0] + hy * q.a[1] + hz * q.a[2]) / aa;
            const v = (hx * q.b[0] + hy * q.b[1] + hz * q.b[2]) / bb;
            if (u < 0 || v < 0 || u > 1 || v > 1) continue;
            zsub[k] = t - (q.sticker ? 1e-4 : 0);
            let col = color;
            if (bits) {
              const mu = (u - m) / (1 - 2 * m);
              const mv = (v - m) / (1 - 2 * m);
              if (mu >= 0 && mv >= 0 && mu < 1 && mv < 1 && bits[Math.floor(mv * 6) * 6 + Math.floor(mu * 6)] < 128) col = black;
            }
            sub2[k * 3] = col[0] * q.light;
            sub2[k * 3 + 1] = col[1] * q.light;
            sub2[k * 3 + 2] = col[2] * q.light;
          }
        }
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let hits = 0;
    for (let s = 0; s < SS * SS; s++) {
      const k = i * SS * SS + s;
      if (zsub[k] === Number.POSITIVE_INFINITY) continue;
      r += sub2[k * 3];
      g += sub2[k * 3 + 1];
      b += sub2[k * 3 + 2];
      hits++;
    }
    if (!hits) continue;
    const n = SS * SS;
    out[i * 3] = (r + bg[0] * (n - hits)) / n;
    out[i * 3 + 1] = (g + bg[1] * (n - hits)) / n;
    out[i * 3 + 2] = (b + bg[2] * (n - hits)) / n;
  }
  return out;
}
