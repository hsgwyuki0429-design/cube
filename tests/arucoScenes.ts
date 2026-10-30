// ArUco ステッカーのキューブの合成場面（比較・調査用）: 崩した状態・ランダムな向き・視点・指・キューブ全体のぶれと、
// 見えているマスの外枠（正解）。tests/debug/stickerDesign.debug.test.ts などで使う
import { COLDIR, NORMAL, ORIENTATIONS, ROWDIR, type Vec3, faceletGeometry, parseMoves } from "../src/cube/model";
import { applyMoveStickers, solvedStickers, stickerAt } from "./arucoCube";
import { type Finger, fingerDistance } from "./render";

export const W = 1280;
export const H = 720; // ライブの認識と同じ長辺
export const FOCAL = Math.max(W, H) * 0.8;
const STICKER = 0.94; // ステッカーの辺（マス = 1。18mm / 19mm）
export const PITCHES = [90, 65, 45]; // 正面のマスの間隔（px）: 1280 で約 24cm・33cm・46cm（1920 なら 36・50・69cm）
export const SHAKES = [0, 0.05, 0.1]; // 露光中のキューブ全体の回転（ラジアン。0.1 で約 6°）

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const n = Math.hypot(...a);
  return [a[0] / n, a[1] / n, a[2] / n];
};
const matv = (m: readonly number[], v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface Cell {
  facelet: number;
  sticker: number; // そこにあるステッカー（= unique54 の ID）
  poly: [number, number][]; // ステッカーの外枠（画像座標）
  center: [number, number];
  facing: number; // カメラへの向き（cos）
  occluded: number; // 指で隠れた割合
  face: number; // ワールドの法線で分けた面（0..5、NORMAL の順）
}

export interface Scene {
  st: ReturnType<typeof solvedStickers>;
  orient: number;
  eye: Vec3;
  fingers: Finger[];
  shake: number;
  pitch: number;
  pattern: string;
  cells: Cell[];
}

function projector(eye: Vec3) {
  const fwd = norm(sub([0, 0, 0], eye));
  const right = norm(cross(fwd, [0, 1, 0]));
  const upv = cross(right, fwd);
  return (p: Vec3): [number, number] => {
    const d = sub(p, eye);
    const zc = dot(d, fwd);
    return [W / 2 + (FOCAL * dot(d, right)) / zc, H / 2 - (FOCAL * dot(d, upv)) / zc];
  };
}

// 見えているマス（ステッカーの外枠・向き）
export function visibleCells(st: Scene["st"], orient: number, eye: Vec3): Omit<Cell, "occluded">[] {
  const at = stickerAt(st);
  const world = ORIENTATIONS[orient];
  const project = projector(eye);
  const out: Omit<Cell, "occluded">[] = [];
  for (let fl = 0; fl < 54; fl++) {
    const g = faceletGeometry(fl);
    const f = Math.floor(fl / 9);
    const n = matv(world, g.normal);
    const c = matv(world, [g.pos[0] + g.normal[0] * 0.5, g.pos[1] + g.normal[1] * 0.5, g.pos[2] + g.normal[2] * 0.5]);
    const facing = dot(n, norm(sub(eye, c)));
    if (facing <= 0.05) continue;
    const r = matv(world, ROWDIR[f]);
    const k = matv(world, COLDIR[f]);
    const corner = (u: number, v: number): [number, number] => project([c[0] + (k[0] * u + r[0] * v) * STICKER, c[1] + (k[1] * u + r[1] * v) * STICKER, c[2] + (k[2] * u + r[2] * v) * STICKER]);
    const poly = [corner(-0.5, -0.5), corner(0.5, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5)];
    const face = NORMAL.findIndex((nn) => dot(nn, n) > 0.99);
    out.push({ facelet: fl, sticker: at[fl], poly, center: project(c), facing, face });
  }
  return out;
}

export function inPoly(poly: [number, number][], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (c === 0) continue;
    if (!sign) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

// ステッカーの 9×9 点のうち指に隠れた割合
function occludedRate(poly: [number, number][], fingers: Finger[]): number {
  if (!fingers.length) return 0;
  let n = 0;
  let hit = 0;
  for (let i = 0; i < 9; i++)
    for (let j = 0; j < 9; j++) {
      const u = (i + 0.5) / 9;
      const v = (j + 0.5) / 9;
      // 双線形で外枠の中の点
      const x = (1 - u) * (1 - v) * poly[0][0] + u * (1 - v) * poly[1][0] + u * v * poly[2][0] + (1 - u) * v * poly[3][0];
      const y = (1 - u) * (1 - v) * poly[0][1] + u * (1 - v) * poly[1][1] + u * v * poly[2][1] + (1 - u) * v * poly[3][1];
      n++;
      if (fingers.some((fg) => fingerDistance(fg, x, y) <= fg.width / 2)) hit++;
    }
  return hit / n;
}

// 指の置き方: なし / 持ち方どおり（正面の下の角に親指、上の面の手前に人差し指、横の面に中指）/ ランダム（1〜2 本）
function makeFingers(cells: Omit<Cell, "occluded">[], pitch: number, rnd: () => number, pattern: string): Finger[] {
  const width = () => pitch * (0.75 + 0.2 * rnd());
  const jitter = (p: [number, number], k = 0.45): [number, number] => [p[0] + (rnd() - 0.5) * 2 * k * pitch, p[1] + (rnd() - 0.5) * 2 * k * pitch];
  const byFace = new Map<number, Omit<Cell, "occluded">[]>();
  for (const c of cells) if (c.facing > 0.25) byFace.set(c.face, [...(byFace.get(c.face) ?? []), c]);
  const faces = [...byFace.values()].sort((a, b) => b[0].facing - a[0].facing);
  if (!faces.length || pattern === "none") return [];
  const out: Finger[] = [];
  if (pattern === "grip") {
    const front = faces.reduce((a, b) => (Math.max(...b.map((c) => c.facing)) > Math.max(...a.map((c) => c.facing)) ? b : a));
    const bottom = [...front].sort((a, b) => b.center[1] - a.center[1]).slice(0, 3).sort((a, b) => a.center[0] - b.center[0]);
    for (const [cell, sx] of [
      [bottom[0], -1],
      [bottom[bottom.length - 1], 1],
    ] as const) {
      if (rnd() < 0.2) continue; // 親指を離している
      const tip = jitter(cell.center);
      out.push({ a: [tip[0] + sx * pitch * (0.5 + rnd()), tip[1] + pitch * 3.5], b: tip, width: width() });
    }
    const others = faces.filter((f) => f !== front);
    const top = others.find((f) => f.reduce((s, c) => s + c.center[1], 0) / f.length < front.reduce((s, c) => s + c.center[1], 0) / front.length);
    if (top && rnd() < 0.7) {
      const near = [...top].sort((a, b) => b.center[1] - a.center[1]).slice(0, 3);
      const tip = jitter(near[Math.floor(rnd() * near.length)].center);
      out.push({ a: [tip[0] + (rnd() - 0.5) * 3 * pitch, tip[1] - pitch * 3.5], b: tip, width: width() });
    }
    const side = others.find((f) => f !== top);
    if (side && rnd() < 0.6) {
      const c = side[Math.floor(rnd() * side.length)];
      const tip = jitter(c.center);
      const sx = c.center[0] > W / 2 ? 1 : -1;
      out.push({ a: [tip[0] + sx * pitch * 3.5, tip[1] + (rnd() - 0.3) * pitch * 2], b: tip, width: width() });
    }
    return out;
  }
  const visible = faces.flat();
  const k = rnd() < 0.5 ? 1 : 2;
  for (let i = 0; i < k; i++) {
    const tip = jitter(visible[Math.floor(rnd() * visible.length)].center, 0.5);
    const ang = rnd() * Math.PI * 2;
    out.push({ a: [tip[0] + Math.cos(ang) * pitch * 3.5, tip[1] + Math.sin(ang) * pitch * 3.5], b: tip, width: width() });
  }
  return out;
}

const ALL_MOVES = parseMoves("U U2 U' R R2 R' F F2 F' D D2 D' L L2 L' B B2 B'");

export function makeScenes(perPitch: number): Scene[] {
  const scenes: Scene[] = [];
  let seed = 1;
  for (const pitch of PITCHES) {
    for (let i = 0; i < perPitch; i++) {
      const rnd = rng(seed++ * 7919);
      let st = solvedStickers();
      for (let k = 0; k < 12; k++) st = applyMoveStickers(st, ALL_MOVES[Math.floor(rnd() * 18)]);
      const orient = Math.floor(rnd() * 24);
      // 正面・上・右（か左）が見える方向から。距離は正面のマスの間隔が pitch になるところ
      const dir = norm([(rnd() - 0.4) * 1.3, 0.25 + rnd() * 0.45, 1]);
      const d = 1.5 + FOCAL / pitch;
      const eye: Vec3 = [dir[0] * d, dir[1] * d, dir[2] * d];
      const cells0 = visibleCells(st, orient, eye);
      const u = rnd();
      const pattern = u < 0.2 ? "none" : u < 0.65 ? "grip" : "random";
      const fingers = makeFingers(cells0, pitch, rnd, pattern);
      const shake = SHAKES[i % SHAKES.length];
      const cells = cells0.map((c) => ({ ...c, occluded: occludedRate(c.poly, fingers) }));
      scenes.push({ st, orient, eye, fingers, shake, pitch, pattern, cells });
    }
  }
  return scenes;
}

