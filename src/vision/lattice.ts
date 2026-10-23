// ステッカー候補（四角形）の集まりから、キューブの面（3x3 格子）を見つける。OpenCV に依存しない純粋関数。
//
// 1. 形（2辺のベクトル）が似ていて、中心間の変位が「ピッチの整数倍」になる四角形どうしを隣接とみなす
// 2. 連結成分ごとに格子座標を振る（透視の歪みに強いよう、各ステッカー自身の辺ベクトルで局所的に解く）
// 3. 3x3 の窓に最も多く入る位置を選び、ステッカーの中心と角から射影変換を当てはめる
// 4. 外れ値を除いて当てはめ直す。1つの面を取り出したら残りで繰り返す（最大3面）
//
// 面の格子の向き（どれが上か）はここでは決めない。layout.ts がカメラフレームの面と向きを決める。
//
// 参考: AllefDouglasDev/rubik-cube (MIT) の faceLocator.ts は「大きさと角度が近い四角形を集め、回転を戻して
// 格子に吸着させる」方式。ここでは斜めから見た面（上面・側面）も拾えるよう、回転だけでなく
// アフィン／射影の歪みを許す形に一般化している。
import { type Mat3, type Pt, applyH, fitHomography } from "./homography";

export interface Quad {
  center: Pt;
  corners: Pt[]; // 4点（順不同でよい）
  area: number;
}

export interface LatticeFace {
  H: Mat3; // 格子座標 (u, v) ∈ [0,3]² → 画像座標
  found: number; // 窓の中で見つかったステッカー数
  cellQuad: number[]; // 格子セル (v*3+u) ごとの四角形番号（無ければ -1）
  residual: number; // ピッチ単位の平均再投影誤差
  pitch: number; // 画像上のピッチ（px）
  alts: Mat3[]; // 窓の位置が一意に決まらないときの、ずらした候補
}

export interface LatticeOptions {
  minStickers: number;
  maxFaces: number;
  angleTolDeg: number;
  sizeTol: number; // 辺の長さ比の許容（1.6 なら 1/1.6〜1.6）
  snapTol: number; // 格子点への吸着の許容（ピッチ単位）
}

export const DEFAULT_LATTICE: LatticeOptions = {
  minStickers: 4,
  maxFaces: 3,
  angleTolDeg: 18,
  sizeTol: 1.6,
  snapTol: 0.3,
};

interface Node {
  q: Quad;
  idx: number;
  corners: Pt[]; // 時計回り（画像座標で y 下向き）
  a: Pt;
  b: Pt;
}

const sub = (p: Pt, q: Pt): Pt => [p[0] - q[0], p[1] - q[1]];
const len = (v: Pt) => Math.hypot(v[0], v[1]);
const crossZ = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];

function makeNode(q: Quad, idx: number): Node {
  const [cx, cy] = q.center;
  const corners = [...q.corners].sort((p, r) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(r[1] - cy, r[0] - cx));
  const [p0, p1, p2, p3] = corners;
  const a: Pt = [(p1[0] - p0[0] + p2[0] - p3[0]) / 2, (p1[1] - p0[1] + p2[1] - p3[1]) / 2];
  const b: Pt = [(p2[0] - p1[0] + p3[0] - p0[0]) / 2, (p2[1] - p1[1] + p3[1] - p0[1]) / 2];
  return { q, idx, corners, a, b };
}

// 基底を 90° 刻みで回した 4 通り（鏡映なし）
function rotations(a: Pt, b: Pt): [Pt, Pt][] {
  return [
    [a, b],
    [b, [-a[0], -a[1]]],
    [[-a[0], -a[1]], [-b[0], -b[1]]],
    [[-b[0], -b[1]], a],
  ];
}

const cosAngle = (u: Pt, v: Pt) => (u[0] * v[0] + u[1] * v[1]) / (len(u) * len(v) || 1);

// j の基底を i の基底に最も揃う回転にしたもの
function aligned(ref: [Pt, Pt], a: Pt, b: Pt): [Pt, Pt] {
  let best = rotations(a, b)[0];
  let bestScore = -Infinity;
  for (const r of rotations(a, b)) {
    const s = cosAngle(ref[0], r[0]) + cosAngle(ref[1], r[1]);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  return best;
}

function similarShape(i: Node, j: Node, o: LatticeOptions): boolean {
  const [a, b] = aligned([i.a, i.b], j.a, j.b);
  const cosTol = Math.cos((o.angleTolDeg * Math.PI) / 180);
  if (cosAngle(i.a, a) < cosTol || cosAngle(i.b, b) < cosTol) return false;
  const ra = len(a) / (len(i.a) || 1);
  const rb = len(b) / (len(i.b) || 1);
  return ra < o.sizeTol && ra > 1 / o.sizeTol && rb < o.sizeTol && rb > 1 / o.sizeTol;
}

// d = α a + β b を解く
function solve2(d: Pt, a: Pt, b: Pt): Pt {
  const det = crossZ(a, b);
  if (Math.abs(det) < 1e-9) return [NaN, NaN];
  return [crossZ(d, b) / det, crossZ(a, d) / det];
}

function median(v: number[]): number {
  const s = [...v].sort((p, q) => p - q);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

// ステッカーの辺に対するピッチ（ステッカー間隔）の比を推定
function estimateRho(nodes: Node[], o: LatticeOptions): number {
  const samples: number[] = [];
  for (const i of nodes) {
    const reach = 2.2 * Math.max(len(i.a), len(i.b));
    for (const j of nodes) {
      if (i === j) continue;
      const d = sub(j.q.center, i.q.center);
      if (len(d) > reach) continue;
      if (!similarShape(i, j, o)) continue;
      const [al, be] = solve2(d, i.a, i.b);
      if (Math.abs(be) < 0.25 && Math.abs(al) > 0.9 && Math.abs(al) < 1.7) samples.push(Math.abs(al));
      else if (Math.abs(al) < 0.25 && Math.abs(be) > 0.9 && Math.abs(be) < 1.7) samples.push(Math.abs(be));
    }
  }
  return samples.length ? median(samples) : NaN;
}

function relation(i: Node, j: Node, rho: number, o: LatticeOptions, basis?: [Pt, Pt]): [number, number] | null {
  const [a, b] = basis ?? [i.a, i.b];
  const d = sub(j.q.center, i.q.center);
  const [al, be] = solve2(d, a, b);
  const k = Math.round(al / rho);
  const l = Math.round(be / rho);
  if ((k === 0 && l === 0) || Math.abs(k) > 2 || Math.abs(l) > 2) return null;
  if (Math.hypot(al / rho - k, be / rho - l) > o.snapTol) return null;
  return [k, l];
}

// pt（画像座標）が「ステッカーらしい」か（+）／「キューブの黒い本体・背景らしい」か（−）を返す。
// 見つかったステッカーが少なくて 3x3 の窓の位置が決まらないときに使う。
export type CellScorer = (pt: Pt) => number;

// 面の候補（窓の位置）そのものへの加点。直前のフレームの面に近い位置を優先するのに使う
export type FaceScorer = (H: Mat3) => number;

export function findFaces(quads: Quad[], options: Partial<LatticeOptions> = {}, scoreCell?: CellScorer, scoreFace?: FaceScorer): LatticeFace[] {
  const o = { ...DEFAULT_LATTICE, ...options };
  let nodes = quads.map(makeNode).filter((n) => crossZ(n.a, n.b) > 0);
  if (nodes.length < o.minStickers) return [];
  const rho = estimateRho(nodes, o);
  if (!Number.isFinite(rho)) return [];

  const faces: LatticeFace[] = [];
  while (faces.length < o.maxFaces && nodes.length >= o.minStickers) {
    const face = extractBestFace(nodes, rho, o, scoreCell, scoreFace);
    if (!face) break;
    faces.push(face.face);
    const used = new Set(face.used);
    nodes = nodes.filter((n) => !used.has(n.idx) && !face.covers(n.q.center));
  }
  return faces;
}

function components(nodes: Node[], rho: number, o: LatticeOptions): Node[][] {
  const adj = nodes.map(() => [] as number[]);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (!similarShape(nodes[i], nodes[j], o)) continue;
      if (relation(nodes[i], nodes[j], rho, o) && relation(nodes[j], nodes[i], rho, o)) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }
  const seen = new Array(nodes.length).fill(false);
  const out: Node[][] = [];
  for (let s = 0; s < nodes.length; s++) {
    if (seen[s]) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = true;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      for (const j of adj[i]) if (!seen[j]) (seen[j] = true), stack.push(j);
    }
    out.push(comp.map((i) => nodes[i]));
  }
  return out;
}

interface Extracted {
  face: LatticeFace;
  used: number[];
  covers: (p: Pt) => boolean;
}

function extractBestFace(nodes: Node[], rho: number, o: LatticeOptions, scoreCell?: CellScorer, scoreFace?: FaceScorer): Extracted | null {
  let best: Extracted | null = null;
  for (const comp of components(nodes, rho, o)) {
    if (comp.length < o.minStickers) continue;
    const r = fitComponent(comp, rho, o, scoreCell, scoreFace);
    if (r && (!best || r.face.found > best.face.found || (r.face.found === best.face.found && r.face.residual < best.face.residual))) best = r;
  }
  return best;
}

// 格子座標を (du, dv) ずらした射影変換: H'(u, v) = H(u + du, v + dv)
export function shiftH(H: Mat3, du: number, dv: number): Mat3 {
  return [H[0], H[1], H[0] * du + H[1] * dv + H[2], H[3], H[4], H[3] * du + H[4] * dv + H[5], H[6], H[7], H[6] * du + H[7] * dv + H[8]];
}

function fitComponent(comp: Node[], rho: number, o: LatticeOptions, scoreCell?: CellScorer, scoreFace?: FaceScorer): Extracted | null {
  // 次数の大きいものを基準に
  const degree = comp.map((i) => comp.filter((j) => j !== i && relation(i, j, rho, o)).length);
  const seed = comp[degree.indexOf(Math.max(...degree))];
  const ref: [Pt, Pt] = [seed.a, seed.b];
  const basis = new Map<Node, [Pt, Pt]>(comp.map((n) => [n, aligned(ref, n.a, n.b)]));
  const coord = new Map<Node, [number, number]>([[seed, [0, 0]]]);
  const queue = [seed];
  while (queue.length) {
    const i = queue.shift()!;
    const [ci, li] = coord.get(i)!;
    for (const j of comp) {
      if (coord.has(j)) continue;
      const rel = relation(i, j, rho, o, basis.get(i));
      if (!rel) continue;
      coord.set(j, [ci + rel[0], li + rel[1]]);
      queue.push(j);
    }
  }
  const placed = [...coord.entries()];
  const ks = placed.map(([, c]) => c[0]);
  const ls = placed.map(([, c]) => c[1]);
  // 最も多く入る 3x3 の窓（同数なら全部を候補に）
  let windows: { k0: number; l0: number }[] = [];
  let bestCount = 0;
  for (let k0 = Math.min(...ks) - 2; k0 <= Math.max(...ks); k0++) {
    for (let l0 = Math.min(...ls) - 2; l0 <= Math.max(...ls); l0++) {
      const n = placed.filter(([, [k, l]]) => k >= k0 && k < k0 + 3 && l >= l0 && l < l0 + 3).length;
      if (n > bestCount) {
        bestCount = n;
        windows = [{ k0, l0 }];
      } else if (n === bestCount) windows.push({ k0, l0 });
    }
  }
  if (!windows.length) return null;
  const { k0, l0 } = windows[0];
  const inWin = placed.filter(([, [k, l]]) => k >= k0 && k < k0 + 3 && l >= l0 && l < l0 + 3);
  // 同じセルに2つ来たら最初のものを残す
  const byCell = new Map<number, Node>();
  for (const [n, [k, l]] of inWin) {
    const cell = (l - l0) * 3 + (k - k0);
    if (!byCell.has(cell)) byCell.set(cell, n);
  }
  let members = [...byCell.entries()].map(([cell, n]) => ({ cell, n }));
  if (members.length < o.minStickers) return null;
  const spread = (sel: typeof members) => new Set(sel.map((m) => m.cell % 3)).size >= 2 && new Set(sel.map((m) => Math.floor(m.cell / 3))).size >= 2;
  if (!spread(members)) return null;

  const half = 0.5 / rho;
  const fit = (sel: typeof members) => {
    const src: Pt[] = [];
    const dst: Pt[] = [];
    const w: number[] = [];
    for (const { cell, n } of sel) {
      const u = (cell % 3) + 0.5;
      const v = Math.floor(cell / 3) + 0.5;
      src.push([u, v]);
      dst.push(n.q.center);
      w.push(3);
      const [A, B] = basis.get(n)!;
      for (const c of n.corners) {
        const [sa, sb] = solve2(sub(c, n.q.center), A, B);
        src.push([u + Math.sign(sa) * half, v + Math.sign(sb) * half]);
        dst.push(c);
        w.push(1);
      }
    }
    return fitHomography(src, dst, w);
  };
  let H = fit(members);
  const pitch = rho * median(members.map(({ n }) => (len(basis.get(n)![0]) + len(basis.get(n)![1])) / 2));
  const err = (H: Mat3, m: (typeof members)[number]) => {
    const p = applyH(H, (m.cell % 3) + 0.5, Math.floor(m.cell / 3) + 0.5);
    return len(sub(p, m.n.q.center)) / pitch;
  };
  for (let iter = 0; iter < 3 && H; iter++) {
    const errs = members.map((m) => err(H!, m));
    const worst = errs.indexOf(Math.max(...errs));
    if (errs[worst] < 0.25 || members.length <= o.minStickers) break;
    const rest = members.filter((_, i) => i !== worst);
    if (!spread(rest)) break;
    members = rest;
    H = fit(members);
  }
  if (!H) return null;
  const residual = members.reduce((s, m) => s + err(H!, m), 0) / members.length;
  if (residual > 0.3) return null;

  // 窓の位置が一意に決まらないとき: 見つかっていないセルが「ステッカーらしい」ずらし方を選ぶ
  const occupied = new Set(members.map((m) => m.cell));
  const shifts = windows.map((w) => [w.k0 - k0, w.l0 - l0] as [number, number]).filter(([du, dv]) => {
    // ずらした後も見つかったステッカーが全部窓に入ること
    return members.every((m) => {
      const u = (m.cell % 3) - du;
      const v = Math.floor(m.cell / 3) - dv;
      return u >= 0 && u < 3 && v >= 0 && v < 3;
    });
  });
  let shift: [number, number] = [0, 0];
  if (shifts.length > 1 && (scoreCell || scoreFace)) {
    let bestScore = -Infinity;
    for (const [du, dv] of shifts) {
      const Hs = shiftH(H, du, dv);
      let score = scoreFace ? scoreFace(Hs) : 0;
      for (let cell = 0; cell < 9 && scoreCell; cell++) {
        const u = cell % 3;
        const v = Math.floor(cell / 3);
        if (occupied.has((v + dv) * 3 + (u + du))) continue;
        score += scoreCell(applyH(Hs, u + 0.5, v + 0.5));
      }
      if (score > bestScore + 1e-9) {
        bestScore = score;
        shift = [du, dv];
      }
    }
  }
  const alts = shifts.filter(([du, dv]) => du !== shift[0] || dv !== shift[1]).map(([du, dv]) => shiftH(H!, du, dv));
  const finalH = shiftH(H, shift[0], shift[1]);
  const cellQuad = new Array(9).fill(-1);
  for (const { cell, n } of members) {
    const u = (cell % 3) - shift[0];
    const v = Math.floor(cell / 3) - shift[1];
    cellQuad[v * 3 + u] = n.idx;
  }
  // 面の外形が凸で、画像上で表向き（時計回り）であること
  const outline = [applyH(finalH, 0, 0), applyH(finalH, 3, 0), applyH(finalH, 3, 3), applyH(finalH, 0, 3)];
  for (let i = 0; i < 4; i++) {
    const e1 = sub(outline[(i + 1) % 4], outline[i]);
    const e2 = sub(outline[(i + 2) % 4], outline[(i + 1) % 4]);
    if (crossZ(e1, e2) <= 0) return null;
  }
  // 他の面の候補を消すのは、確実にこの面に属する範囲（見つかったステッカーを囲む範囲）だけ
  const us = members.map((m) => m.cell % 3);
  const vs = members.map((m) => Math.floor(m.cell / 3));
  const core = [
    applyH(H, Math.min(...us), Math.min(...vs)),
    applyH(H, Math.max(...us) + 1, Math.min(...vs)),
    applyH(H, Math.max(...us) + 1, Math.max(...vs) + 1),
    applyH(H, Math.min(...us), Math.max(...vs) + 1),
  ];
  return {
    face: { H: finalH, found: members.length, cellQuad, residual, pitch, alts },
    used: members.map((m) => m.n.idx),
    covers: (p: Pt) => pointInPolygon(p, core),
  };
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
