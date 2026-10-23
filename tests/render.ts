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
  realism?: Realism;
}

// 実物らしさ: 合成画像は素直すぎて、実物の難しさ（艶の映り込み・丸い角・カメラの色合い・白飛び・ぼけ・
// 指・背景の模様）を試せない。ここで足す
export interface Realism {
  corner?: number; // ステッカーの角の丸み（ステッカーの半幅に対する割合、0..0.6）
  lights?: { pos: Vec3; strength: number; shininess: number }[]; // 点光源（ワールド座標）。艶の映り込みになる
  stickerGloss?: number; // ステッカーの艶（映り込みの強さの倍率、既定 1）
  shading?: number; // 点光源による面内の明るさのむら（0..1）
  whiteBalance?: Rgb; // チャンネルごとの倍率（暖色なら [1.08, 1, 0.82] など）
  exposure?: number; // 明るさの倍率（1.3 などで白・黄が飛ぶ）
  blur?: number; // ぼけ（箱型、半径 px）
  fingers?: Finger[]; // 指（画像座標のカプセル）
  backdrop?: "plain" | "plaid" | "clutter"; // 背景の模様
}

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

function fillPolygon(img: Uint8ClampedArray, w: number, h: number, poly: [number, number][], color: Rgb, light: number, ids?: Int32Array, id = -1) {
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
      if (ids) ids[y * w + x] = id;
    }
  }
}

// 角の丸い四角形（平面上、中心 c・行方向 rd・列方向 cd・半幅 hs・丸み r）
function roundedRect(c: Vec3, rd: Vec3, cd: Vec3, hs: number, r: number, steps = 20): Vec3[] {
  const out: Vec3[] = [];
  for (let t = 0; t < steps; t++) {
    const th = (2 * Math.PI * (t + 0.5)) / steps;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const u = Math.sign(cs) * (hs - r) + r * cs;
    const v = Math.sign(sn) * (hs - r) + r * sn;
    out.push(add(c, add(scale(rd, v), scale(cd, u))));
  }
  return out;
}

interface Poly {
  pts: Vec3[];
  color: Rgb;
  light: number;
  depth: number;
  normal: Vec3; // ワールド座標の法線
  sticker: boolean;
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
  const re = o.realism;
  if (re?.backdrop === "plaid") {
    // チェックのシャツ: 薄いピンクに暗い格子
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const line = x % 34 < 4 || y % 30 < 4;
        const k = (y * w + x) * 4;
        img[k] = line ? 120 : 215;
        img[k + 1] = line ? 80 : 160;
        img[k + 2] = line ? 120 : 185;
      }
  } else if (re?.backdrop === "clutter") {
    // ステッカーに似た色の物が散らばった机
    let cs = 99;
    const r2 = () => ((cs = (cs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 40; n++) {
      const cx = r2() * w;
      const cy = r2() * h;
      const sz = 10 + r2() * 40;
      const col = [PALETTE[Math.floor(r2() * 6)], [140, 120, 100] as Rgb, [60, 60, 70] as Rgb][Math.floor(r2() * 3)];
      fillPolygon(img, w, h, [[cx, cy], [cx + sz, cy + sz * 0.2], [cx + sz * 0.8, cy + sz], [cx - sz * 0.1, cy + sz * 0.9]], col, 0.85);
    }
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
          const nWn = norm(nW);
          polys.push({ pts: quad(center, 0.49), color: o.seam ?? [18, 18, 18], light: 1, depth, normal: nWn, sticker: false });
          if (dot(p, n) === 1) {
            const color = palette[o.state[faceletAt(p, n)]];
            const sc = add(p, scale(n, 0.495));
            const pts = re?.corner ? roundedRect(sc, rd, cd, 0.5 - gap, (0.5 - gap) * re.corner).map((q) => toWorld(q, inTurn)) : quad(sc, 0.5 - gap);
            polys.push({ pts, color, light: lightOf(nW), depth: depth - 0.001, normal: nWn, sticker: true });
          }
        }
      }
  polys.sort((a, b) => b.depth - a.depth);
  const ids = re?.lights?.length ? new Int32Array(w * h).fill(-1) : undefined;
  polys.forEach((pl, i) => fillPolygon(img, w, h, pl.pts.map(project), pl.color, pl.light, ids, i));

  // 艶の映り込みと面内のむら（点光源・ブリン＝フォン）。画素ごとに視線と面の交点を求める
  if (ids && re?.lights) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const id = ids[y * w + x];
        if (id < 0) continue;
        const pl = polys[id];
        const d = norm(add(fwd, add(scale(right, (x + 0.5 - w / 2) / f), scale(upv, -(y + 0.5 - h / 2) / f))));
        const den = dot(pl.normal, d);
        if (Math.abs(den) < 1e-6) continue;
        const t = dot(pl.normal, sub(pl.pts[0], o.eye)) / den;
        const P = add(o.eye, scale(d, t));
        const V = scale(d, -1);
        let spec = 0;
        let diff = 0;
        for (const L of re.lights) {
          const Ld = norm(sub(L.pos, P));
          const Hh = norm(add(Ld, V));
          spec += L.strength * Math.pow(Math.max(0, dot(pl.normal, Hh)), L.shininess);
          diff += Math.max(0, dot(pl.normal, Ld));
        }
        const gloss = pl.sticker ? (re.stickerGloss ?? 1) : 0.5;
        const shade = 1 - (re.shading ?? 0) * (1 - Math.min(1, diff / re.lights.length));
        const k = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) img[k + c] = img[k + c] * shade + 255 * spec * gloss;
      }
  }

  for (const fg of re?.fingers ?? []) {
    // 指: 肌色のカプセル。幅方向に陰影をつける
    const col = fg.color ?? [222, 170, 140];
    const poly = fingerPolygon(fg);
    const xs = poly.map((q) => q[0]);
    const ys = poly.map((q) => q[1]);
    const dx = fg.b[0] - fg.a[0];
    const dy = fg.b[1] - fg.a[1];
    const len = Math.hypot(dx, dy) || 1;
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(h - 1, Math.ceil(Math.max(...ys))); y++)
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(w - 1, Math.ceil(Math.max(...xs))); x++) {
        // 線分までの距離
        const t = Math.max(0, Math.min(1, ((x - fg.a[0]) * dx + (y - fg.a[1]) * dy) / (len * len)));
        const px = fg.a[0] + dx * t;
        const py = fg.a[1] + dy * t;
        const dist = Math.hypot(x - px, y - py);
        if (dist > fg.width / 2) continue;
        const shade = 0.75 + 0.35 * Math.sqrt(Math.max(0, 1 - (dist / (fg.width / 2)) ** 2));
        const k = (y * w + x) * 4;
        img[k] = col[0] * shade;
        img[k + 1] = col[1] * shade;
        img[k + 2] = col[2] * shade;
      }
  }

  // カメラの色合い・露出（白飛び）・ぼけ
  if (re?.whiteBalance || re?.exposure) {
    const wb = re.whiteBalance ?? [1, 1, 1];
    const ex = re.exposure ?? 1;
    for (let i = 0; i < w * h * 4; i += 4) for (let c = 0; c < 3; c++) img[i + c] = img[i + c] * wb[c] * ex;
  }
  if (re?.blur) {
    const r = Math.round(re.blur);
    const tmp = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          let n = 0;
          for (let k = -r; k <= r; k++) {
            const xx = x + k;
            if (xx < 0 || xx >= w) continue;
            sum += img[(y * w + xx) * 4 + c];
            n++;
          }
          tmp[(y * w + x) * 4 + c] = sum / n;
        }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          let n = 0;
          for (let k = -r; k <= r; k++) {
            const yy = y + k;
            if (yy < 0 || yy >= h) continue;
            sum += tmp[(yy * w + x) * 4 + c];
            n++;
          }
          img[(y * w + x) * 4 + c] = sum / n;
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

// renderCube と同じ投影で、ワールド座標の点を画像に（指をキューブの位置に合わせて置くのに使う）
export function projectPoint(o: Pick<RenderOptions, "width" | "height" | "eye" | "target" | "up" | "focal">, p: Vec3): [number, number] {
  const target = o.target ?? [0, 0, 0];
  const fwd = norm(sub(target, o.eye));
  const right = norm(cross(fwd, o.up ?? [0, 1, 0]));
  const upv = cross(right, fwd);
  const f = o.focal ?? o.width * 1.1;
  const d = sub(p, o.eye);
  const zc = dot(d, fwd);
  return [o.width / 2 + (f * dot(d, right)) / zc, o.height / 2 - (f * dot(d, upv)) / zc];
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
