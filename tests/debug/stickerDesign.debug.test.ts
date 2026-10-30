// ステッカーの中のマーカーの配置（大きさ・個数・暗いマスの色。src/aruco/design.ts）の比較。
// 合成キューブ（54 種類・3×3 の符号）に指を描き、見えているマスごとに「何割隠れたか」と「そのマスの ID が読めたか」を数える。
// 同じ場面（状態・向き・視点・指・ぶれ）をすべての案で描いて比べる。
//   npx vitest run -c vitest.debug.config.ts tests/debug/stickerDesign.debug.test.ts
//   N=場面の数（距離ごと、既定 24）・DESIGNS=standard,half（key で絞る）・SAVE=1（案ごとの見本の画像も）・OUT=出力先（既定 e2e-output/sticker-design）
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "vitest";
import { DESIGNS, designLook } from "../../src/aruco/design";
import { ArucoBench, DEFAULT_CONFIGS } from "../../src/aruco/detect";
import { COLDIR, NORMAL, ORIENTATIONS, ROWDIR, type Vec3, faceletGeometry, parseMoves } from "../../src/cube/model";
import { initOpenCv } from "../../src/vision/quads";
import { applyMoveStickers, renderArucoCube, solvedStickers, stickerAt } from "../arucoCube";
import { type Finger, fingerDistance } from "../render";
import { writePng } from "./png";

const W = 1280;
const H = 720; // ライブの認識と同じ長辺
const FOCAL = Math.max(W, H) * 0.8;
const STICKER = 0.94; // ステッカーの辺（マス = 1。18mm / 19mm）
const PITCHES = [90, 65, 45]; // 正面のマスの間隔（px）: 1280 で約 24cm・33cm・46cm（1920 なら 36・50・69cm）
const SHAKES = [0, 0.05, 0.1]; // 露光中のキューブ全体の回転（ラジアン。0.1 で約 6°）
const BINS = [0, 0.25, 0.5, 0.75, 1.0001]; // 隠れた割合: 0 / 〜25% / 〜50% / 〜75% / それ以上

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const n = Math.hypot(...a);
  return [a[0] / n, a[1] / n, a[2] / n];
};
const matv = (m: readonly number[], v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Cell {
  facelet: number;
  sticker: number; // そこにあるステッカー（= unique54 の ID）
  poly: [number, number][]; // ステッカーの外枠（画像座標）
  center: [number, number];
  facing: number; // カメラへの向き（cos）
  occluded: number; // 指で隠れた割合
  face: number; // ワールドの法線で分けた面（0..5、NORMAL の順）
}

interface Scene {
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
function visibleCells(st: Scene["st"], orient: number, eye: Vec3): Omit<Cell, "occluded">[] {
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

function inPoly(poly: [number, number][], x: number, y: number): boolean {
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

function makeScenes(perPitch: number): Scene[] {
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

interface Tally {
  n: number;
  ok: number;
}
const tally = (): Tally => ({ n: 0, ok: 0 });
const pct = (t: Tally) => (t.n ? `${((t.ok / t.n) * 100).toFixed(1)}%` : "-");

it("ステッカーの中のマーカーの配置の比較", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const bench = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "unique54");
  const perPitch = Number(process.env.N ?? 24);
  const only = process.env.DESIGNS?.split(",");
  const designs = DESIGNS.filter((d) => !only || only.includes(d.key));
  const scenes = makeScenes(perPitch);
  const outDir = process.env.OUT ?? "e2e-output/sticker-design";
  mkdirSync(outDir, { recursive: true });
  const results: Record<string, unknown>[] = [];
  for (const design of designs) {
    const t0 = performance.now();
    const all = tally();
    const clear = tally(); // 指に隠れていないマス
    const bins = BINS.map(() => tally());
    const staticBins = BINS.map(() => tally()); // ぶれなし（shake 0）のときだけ
    const staticPitch = PITCHES.map(() => tally());
    const byPitch = PITCHES.map(() => tally());
    const byShake = SHAKES.map(() => tally());
    const byPattern: Record<string, Tally> = { none: tally(), grip: tally(), random: tally() };
    const oblique = tally(); // 向き 0.25〜0.5 の斜めの面（隠れていない）
    let wrong = 0;
    let wrongSameColor = 0; // 同じ色の別の ID（色の照合で見抜けない誤読）
    let cellWrong = 0; // マスの中の多数決（4 個の配置）でも別の ID になったマス
    let outside = 0;
    let copies = 0;
    let identified = 0;
    let frameMs = 0;
    scenes.forEach((sc, si) => {
      const img = renderArucoCube(cv, { width: W, height: H, stickers: sc.st, orient: sc.orient, eye: sc.eye, noise: 2.5, seed: si + 1, scheme: "unique54", design, fingers: sc.fingers, shake: sc.shake || undefined });
      if (process.env.SAVE && si < 3) writePng(`${outDir}/${design.key}-${si}.png`, img);
      const f0 = performance.now();
      const markers = bench.detect(img)[0].markers;
      frameMs += performance.now() - f0;
      const hits = new Map<number, number>(); // マス → 読めたマーカーの数
      const misses = new Map<number, number>(); // マス → 別の ID に読んだマーカーの数
      for (const m of markers) {
        const cx = (m.corners[0] + m.corners[2] + m.corners[4] + m.corners[6]) / 4;
        const cy = (m.corners[1] + m.corners[3] + m.corners[5] + m.corners[7]) / 4;
        const cell = sc.cells.find((c) => inPoly(c.poly, cx, cy));
        if (!cell) outside++;
        else if (cell.sticker !== m.id) {
          wrong++;
          misses.set(cell.facelet, (misses.get(cell.facelet) ?? 0) + 1);
          if (Math.floor(cell.sticker / 9) === Math.floor(m.id / 9)) wrongSameColor++;
        }
        else hits.set(cell.facelet, (hits.get(cell.facelet) ?? 0) + 1);
      }
      for (const c of sc.cells) {
        if (c.facing < 0.25) continue; // ほぼ真横の面は数えない
        // マスの中で正しい ID が多数（同数を含む）なら読めた
        const ok = (hits.get(c.facelet) ?? 0) >= (misses.get(c.facelet) ?? 0) && hits.has(c.facelet) ? 1 : 0;
        if (!ok && misses.has(c.facelet) && c.facing >= 0.25) cellWrong++;
        if (ok) {
          identified++;
          copies += hits.get(c.facelet)!;
        }
        const add = (t: Tally) => {
          t.n++;
          t.ok += ok;
        };
        add(all);
        add(byPattern[sc.pattern]);
        const b = BINS.findIndex((x, k) => c.occluded <= x && (k === 0 || c.occluded > BINS[k - 1]));
        add(bins[Math.max(0, b)]);
        if (!sc.shake) add(staticBins[Math.max(0, b)]);
        if (c.occluded === 0) {
          add(clear);
          add(byPitch[PITCHES.indexOf(sc.pitch)]);
          add(byShake[SHAKES.indexOf(sc.shake)]);
          if (!sc.shake) add(staticPitch[PITCHES.indexOf(sc.pitch)]);
          if (c.facing < 0.5) add(oblique);
        }
      }
    });
    const look = designLook(design);
    const row = {
      key: design.key,
      label: design.label,
      all: pct(all),
      clear: pct(clear),
      bins: bins.map(pct),
      staticBins: staticBins.map(pct),
      staticBinCounts: staticBins.map((t) => t.n),
      staticPitch: staticPitch.map(pct),
      cellWrongPer1000: ((cellWrong / Math.max(1, all.n)) * 1000).toFixed(1),
      byPitch: byPitch.map(pct),
      byShake: byShake.map(pct),
      byPattern: Object.fromEntries(Object.entries(byPattern).map(([k, v]) => [k, pct(v)])),
      oblique: pct(oblique),
      wrongPer1000: ((wrong / Math.max(1, all.n)) * 1000).toFixed(1),
      wrongSameColorPer1000: ((wrongSameColor / Math.max(1, all.n)) * 1000).toFixed(1),
      outside,
      copiesPerCell: (copies / Math.max(1, identified)).toFixed(2),
      cells: all.n,
      binCounts: bins.map((t) => t.n),
      colorArea: `${(look.colorArea * 100).toFixed(0)}%`,
      meanDeltaE: look.meanDeltaE.toFixed(1),
      minPairDeltaE: look.minPairDeltaE.toFixed(1),
      pairs: look.pairs.map((p) => `${p.pair} ${p.dE.toFixed(0)}`).join(" / "),
      msPerFrame: (frameMs / scenes.length).toFixed(1),
      seconds: ((performance.now() - t0) / 1000).toFixed(0),
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  writeFileSync(`${outDir}/results.json`, JSON.stringify({ scenes: scenes.length, pitches: PITCHES, shakes: SHAKES, bins: BINS, results }, null, 2));
  bench.delete();
}, 7200000);
