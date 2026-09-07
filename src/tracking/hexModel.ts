/**
 * 角から見たキューブの「六角形モデル」。初期化と局所再検出に使う。
 *
 * 立方体を角から見ると可視頂点は7個で、3面はそれぞれ辺を共有する。
 * 近い方の頂点 N と、そこから伸びる3本の辺ベクトル p, q, r（計8自由度）で
 * 見え方全体を表せる（弱透視近似）。
 *
 *            N+p+r
 *          /       \
 *      N+p    U     N+r
 *       |  \     /  |
 *       |    N      |
 *   F   |   /   \   |   R
 *      N+p+q     N+q+r
 *          \  N+q  /
 *
 * 追跡中は面ごとに独立したホモグラフィを使う（透視をそのまま扱えるため）。
 * この八自由度モデルは初期化と再検出のためだけのもの。
 */

import type { Point2D, Quad } from './geometry';
import type { GrayImage } from './opticalFlow';
import { sampleBilinear } from './opticalFlow';

export type VisibleFaceId = 'U' | 'F' | 'R';
export const VISIBLE_FACE_IDS: VisibleFaceId[] = ['U', 'F', 'R'];

export interface HexModel {
  /** 手前の頂点（3面が集まる角） */
  N: Point2D;
  /** N から伸びる3辺。p は U と F が共有、q は F と R、r は U と R */
  p: Point2D;
  q: Point2D;
  r: Point2D;
}

const add = (a: Point2D, b: Point2D): Point2D => ({ x: a.x + b.x, y: a.y + b.y });
const add3 = (a: Point2D, b: Point2D, c: Point2D): Point2D => ({ x: a.x + b.x + c.x, y: a.y + b.y + c.y });
const sub = (a: Point2D, b: Point2D): Point2D => ({ x: a.x - b.x, y: a.y - b.y });

/**
 * 六角形モデル -> 3面の四角形。
 * 頂点順は既存 ROI と同じ (0,0)->(1,0)->(1,1)->(0,1)。
 */
export function hexToFaces(m: HexModel): Record<VisibleFaceId, Quad> {
  return {
    U: [add(m.N, m.p), { ...m.N }, add(m.N, m.r), add3(m.N, m.p, m.r)],
    F: [add(m.N, m.p), { ...m.N }, add(m.N, m.q), add3(m.N, m.p, m.q)],
    R: [add(m.N, m.r), { ...m.N }, add(m.N, m.q), add3(m.N, m.q, m.r)],
  };
}

/**
 * 面をまたいで同じ立体頂点を指す (面, 頂点index) の組。
 * 追跡後にここを一致させることで、面同士の共有辺がズレるのを防ぐ。
 */
export const SHARED_VERTEX_GROUPS: { face: VisibleFaceId; corner: number }[][] = [
  [{ face: 'U', corner: 0 }, { face: 'F', corner: 0 }],                                  // N+p
  [{ face: 'U', corner: 1 }, { face: 'F', corner: 1 }, { face: 'R', corner: 1 }],         // N（手前の角）
  [{ face: 'U', corner: 2 }, { face: 'R', corner: 0 }],                                  // N+r
  [{ face: 'F', corner: 2 }, { face: 'R', corner: 2 }],                                  // N+q
];

/** 3面の四角形から六角形モデルを復元する（共有頂点の平均）。 */
export function hexFromFaces(faces: Record<VisibleFaceId, Quad>): HexModel {
  const { U, F, R } = faces;
  const mean = (...pts: Point2D[]): Point2D => ({
    x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
    y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
  });
  const N = mean(U[1], F[1], R[1]);
  return {
    N,
    p: mean(sub(U[0], U[1]), sub(F[0], F[1])),
    q: mean(sub(F[2], F[1]), sub(R[2], R[1])),
    r: mean(sub(U[2], U[1]), sub(R[0], R[1])),
  };
}

/** モデルの9本の辺（内側3本 + 外形6本）。エッジ吸着のスコア計算に使う。 */
export function hexEdges(m: HexModel): [Point2D, Point2D][] {
  const Np = add(m.N, m.p);
  const Nq = add(m.N, m.q);
  const Nr = add(m.N, m.r);
  const Npq = add3(m.N, m.p, m.q);
  const Npr = add3(m.N, m.p, m.r);
  const Nqr = add3(m.N, m.q, m.r);
  return [
    [m.N, Np], [m.N, Nq], [m.N, Nr],
    [Np, Npr], [Nr, Npr],
    [Np, Npq], [Nq, Npq],
    [Nq, Nqr], [Nr, Nqr],
  ];
}

/** モデルの妥当性。3辺が同じ向きに潰れていたり長さが極端だと使えない。 */
export function isPlausibleHex(m: HexModel, minEdge = 12, maxEdge = 4000): boolean {
  const lens = [m.p, m.q, m.r].map((v) => Math.hypot(v.x, v.y));
  if (lens.some((l) => !Number.isFinite(l) || l < minEdge || l > maxEdge)) return false;
  const ratio = Math.max(...lens) / Math.min(...lens);
  if (ratio > 4) return false;
  // 3辺が張る向きが縮退していないか（外積の絶対値）
  const cross = (a: Point2D, b: Point2D) => Math.abs(a.x * b.y - a.y * b.x);
  const area = Math.min(cross(m.p, m.q), cross(m.q, m.r), cross(m.p, m.r));
  return area > minEdge * minEdge * 0.15;
}

// ---------------------------------------------------------------------------
// エッジ吸着（初期化の仕上げ・局所再検出）
// ---------------------------------------------------------------------------

/** 辺に直交する方向の輝度勾配の大きさを、辺に沿って平均する。 */
function edgeScore(img: GrayImage, a: Point2D, b: Point2D, samples: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return 0;
  const nx = -dy / len;
  const ny = dx / len;
  let s = 0;
  let n = 0;
  for (let i = 0; i < samples; i++) {
    // 端は角なので少し内側だけを見る
    const t = (i + 0.5) / samples;
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    if (x < 1 || y < 1 || x > img.width - 2 || y > img.height - 2) continue;
    const g = sampleBilinear(img, x + nx, y + ny) - sampleBilinear(img, x - nx, y - ny);
    s += Math.abs(g);
    n++;
  }
  return n > 0 ? s / n : 0;
}

/** モデル全体のエッジ支持度。大きいほど実際の輪郭に乗っている。 */
export function hexEdgeSupport(img: GrayImage, m: HexModel, samplesPerEdge = 14): number {
  const edges = hexEdges(m);
  let s = 0;
  for (const [a, b] of edges) s += edgeScore(img, a, b, samplesPerEdge);
  return s / edges.length;
}

/**
 * 線に沿った「暗い稜線」の強さ。
 *
 * キューブのステッカー境界は段差エッジではなく、幅を持った暗い線（谷）。
 * |I(+n) - I(-n)| では線の中心で 0 になってしまうので、
 * 両側の明るさの平均から中心の明るさを引く形で測る。
 */
function ridgeAlongLine(img: GrayImage, a: Point2D, b: Point2D, w: number, samples: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return 0;
  const nx = (-dy / len) * w;
  const ny = (dx / len) * w;
  let s = 0;
  let n = 0;
  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) / samples;
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    if (x - Math.abs(nx) < 1 || y - Math.abs(ny) < 1 ||
        x + Math.abs(nx) > img.width - 2 || y + Math.abs(ny) > img.height - 2) continue;
    const side = (sampleBilinear(img, x + nx, y + ny) + sampleBilinear(img, x - nx, y - ny)) / 2;
    s += Math.max(0, side - sampleBilinear(img, x, y));
    n++;
  }
  return n > 0 ? s / n : 0;
}

function project2(H: ArrayLike<number>, u: number, v: number): Point2D {
  const w = H[6] * u + H[7] * v + H[8];
  return { x: (H[0] * u + H[1] * v + H[2]) / w, y: (H[3] * u + H[4] * v + H[5]) / w };
}

/** 面の内側 2x2 のグリッド線。半セルずらしても面内に留まるのでロック比に使える。 */
function internalLines(H: ArrayLike<number>): [Point2D, Point2D][] {
  const at = (u: number, v: number) => project2(H, u, v);
  return [
    [at(1 / 3, 0.04), at(1 / 3, 0.96)], [at(2 / 3, 0.04), at(2 / 3, 0.96)],
    [at(0.04, 1 / 3), at(0.96, 1 / 3)], [at(0.04, 2 / 3), at(0.96, 2 / 3)],
  ];
}

/** 面のおおよその画面上の一辺の長さ（px）。稜線の幅や探索幅の基準にする。 */
export function faceScalePx(H: ArrayLike<number>): number {
  const a = project2(H, 0, 0);
  const b = project2(H, 1, 0);
  const c = project2(H, 0, 1);
  return (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - a.x, c.y - a.y)) / 2;
}

/** 内側グリッド線の稜線強度。 */
export function faceGridSupport(img: GrayImage, H: ArrayLike<number>, samplesPerLine = 12): number {
  const scale = faceScalePx(H);
  if (!Number.isFinite(scale) || scale < 6) return 0;
  const w = Math.max(1.2, Math.min(6, scale * 0.055));
  const lines = internalLines(H);
  let s = 0;
  for (const [a, b] of lines) {
    if (!Number.isFinite(a.x) || !Number.isFinite(b.x)) continue;
    s += ridgeAlongLine(img, a, b, w, samplesPerLine);
  }
  return s / lines.length;
}

/**
 * 「本当にキューブのグリッドに乗っているか」を測る。
 *
 * 正しい位置での稜線強度と、半セルずらした位置での稜線強度の比。
 * 本物の 3x3 グリッド上なら、正しい位置は黒線に乗り、ずらすとステッカー中央に
 * 落ちるので比が大きくなる。背景の一様なテクスチャに貼り付いている場合は
 * どちらも同じくらいになり比は 1 付近になる。
 *
 * 比なので拡大縮小・照明・コントラストの変化に影響されない。
 * 支持度の絶対値を基準値と比べる方式はスケール変化で誤検出するため使わない。
 */
export function gridLockScore(img: GrayImage, H: ArrayLike<number>, samplesPerLine = 12): number {
  const base = faceGridSupport(img, H, samplesPerLine);
  const d = 1 / 6; // 半セル
  let off = 0;
  for (const [du, dv] of [[d, 0], [-d, 0], [0, d], [0, -d]] as [number, number][]) {
    off += faceGridSupport(img, shiftHomography(H, du, dv), samplesPerLine);
  }
  // 0 除算を避けるため 1 階調ぶんの床を置く
  return base / Math.max(off / 4, 1);
}

/**
 * 面の外形（4辺）が実際の輪郭に乗っているかの比。
 *
 * 内側のグリッド線は1セル周期なので、モデルが1セルずれても
 * ロック比は高いままになる（遮蔽からの復帰で実際に起きる）。
 * 外形は周期を持たないので、ここを見ればセル単位のずれを検出できる。
 *
 * 外形は段差エッジ（背景との境 / 別の面との陰影差）なので、
 * 稜線ではなく |I(+n) - I(-n)| で測る。
 */
export function faceOutlineLock(img: GrayImage, H: ArrayLike<number>, samplesPerLine = 14): number {
  const scale = faceScalePx(H);
  if (!Number.isFinite(scale) || scale < 6) return 0;
  const n = Math.max(1, Math.min(4, scale * 0.03));
  const boundary = (M: ArrayLike<number>): number => {
    const at = (u: number, v: number) => project2(M, u, v);
    const lines: [Point2D, Point2D][] = [
      [at(0.03, 0), at(0.97, 0)], [at(1, 0.03), at(1, 0.97)],
      [at(0.97, 1), at(0.03, 1)], [at(0, 0.97), at(0, 0.03)],
    ];
    let s = 0;
    for (const [a, b] of lines) {
      if (!Number.isFinite(a.x) || !Number.isFinite(b.x)) continue;
      s += edgeScoreAt(img, a, b, n, samplesPerLine);
    }
    return s / lines.length;
  };
  const base = boundary(H);
  const d = 1 / 6;
  let off = 0;
  for (const [du, dv] of [[d, 0], [-d, 0], [0, d], [0, -d]] as [number, number][]) {
    off += boundary(shiftHomography(H, du, dv));
  }
  return base / Math.max(off / 4, 1);
}

/** 段差エッジの強さ。辺に直交する ±n px の輝度差。 */
function edgeScoreAt(img: GrayImage, a: Point2D, b: Point2D, n: number, samples: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return 0;
  const nx = (-dy / len) * n;
  const ny = (dx / len) * n;
  let s = 0;
  let c = 0;
  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) / samples;
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    if (x - Math.abs(nx) < 1 || y - Math.abs(ny) < 1 ||
        x + Math.abs(nx) > img.width - 2 || y + Math.abs(ny) > img.height - 2) continue;
    s += Math.abs(sampleBilinear(img, x + nx, y + ny) - sampleBilinear(img, x - nx, y - ny));
    c++;
  }
  return c > 0 ? s / c : 0;
}

/**
 * 面を (u,v) 方向に少しだけ動かして、グリッドに一番よく乗る位置を探す。
 *
 * 探索範囲は半セル（1/6）未満に必ず制限する。それ以上動かせるようにすると
 * 1セル隣の位置にも同じくらい乗ってしまい、セル単位でずれたまま
 * 高いスコアを出す事故が起きる。
 */
export function snapToGrid(
  img: GrayImage,
  H: ArrayLike<number>,
  maxShift = 0.12,
): { du: number; dv: number; lock: number; improved: boolean } {
  const limit = Math.min(maxShift, 0.15);
  let bestDu = 0;
  let bestDv = 0;
  let bestLock = gridLockScore(img, H);
  const start = bestLock;
  for (let step = limit; step >= 0.01; step /= 2) {
    let moved = true;
    let guard = 0;
    while (moved && guard++ < 4) {
      moved = false;
      for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]] as [number, number][]) {
        const du = bestDu + dx;
        const dv = bestDv + dy;
        if (Math.abs(du) > limit || Math.abs(dv) > limit) continue;
        const lock = gridLockScore(img, shiftHomography(H, du, dv));
        if (lock > bestLock + 1e-6) {
          bestLock = lock;
          bestDu = du;
          bestDv = dv;
          moved = true;
        }
      }
    }
  }
  return { du: bestDu, dv: bestDv, lock: bestLock, improved: bestLock > start * 1.02 };
}

/** H を面内 (u,v) 方向に平行移動した合成ホモグラフィ。 */
export function shiftHomographyPublic(H: ArrayLike<number>, du: number, dv: number): Float64Array {
  return shiftHomography(H, du, dv);
}

function shiftHomography(H: ArrayLike<number>, du: number, dv: number): Float64Array {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    out[r * 3] = H[r * 3];
    out[r * 3 + 1] = H[r * 3 + 1];
    out[r * 3 + 2] = H[r * 3] * du + H[r * 3 + 1] * dv + H[r * 3 + 2];
  }
  return out;
}

export interface RefineOptions {
  /** 初期の探索ステップ（px） */
  initialStep: number;
  /** 最小ステップ（px）。ここまで細かくして終わる */
  minStep: number;
  /** 1ステップ幅あたりの座標降下の反復回数 */
  passesPerStep: number;
  samplesPerEdge: number;
}

export function defaultRefineOptions(): RefineOptions {
  return { initialStep: 10, minStep: 0.5, passesPerStep: 2, samplesPerEdge: 14 };
}

type ParamKey = ['N' | 'p' | 'q' | 'r', 'x' | 'y'];
const PARAMS: ParamKey[] = [
  ['N', 'x'], ['N', 'y'], ['p', 'x'], ['p', 'y'],
  ['q', 'x'], ['q', 'y'], ['r', 'x'], ['r', 'y'],
];

function cloneHex(m: HexModel): HexModel {
  return { N: { ...m.N }, p: { ...m.p }, q: { ...m.q }, r: { ...m.r } };
}

/**
 * 8自由度を座標降下でエッジに吸着させる。
 *
 * ここが「大まかな指定 → 実際の輪郭」を埋める部分。局所再検出でも同じ関数を使う
 * （予測位置から少しだけ動かして輪郭に貼り直す）。
 */
export function refineHexModel(
  img: GrayImage,
  initial: HexModel,
  opts: RefineOptions = defaultRefineOptions(),
): { model: HexModel; support: number; improved: number } {
  let best = cloneHex(initial);
  let bestScore = hexEdgeSupport(img, best, opts.samplesPerEdge);
  const startScore = bestScore;

  for (let step = opts.initialStep; step >= opts.minStep; step /= 2) {
    for (let pass = 0; pass < opts.passesPerStep; pass++) {
      let moved = false;
      for (const [group, axis] of PARAMS) {
        for (const dir of [1, -1]) {
          const cand = cloneHex(best);
          cand[group][axis] += dir * step;
          if (!isPlausibleHex(cand)) continue;
          const sc = hexEdgeSupport(img, cand, opts.samplesPerEdge);
          if (sc > bestScore) {
            bestScore = sc;
            best = cand;
            moved = true;
            break;
          }
        }
      }
      if (!moved) break;
    }
  }
  return { model: best, support: bestScore, improved: bestScore - startScore };
}

/**
 * タップ点から初期モデルを作る。
 * タップ位置をキューブの中心とみなし、標準的な角視の向きで辺ベクトルを置く。
 * この後 refineHexModel で輪郭に吸着させる。
 */
export function seedHexFromTap(tap: Point2D, radius: number): HexModel {
  // 標準的な角視: p は左上へ、q は下へ、r は右上へ
  const p: Point2D = { x: -radius * 0.86, y: -radius * 0.5 };
  const q: Point2D = { x: 0, y: radius };
  const r: Point2D = { x: radius * 0.86, y: -radius * 0.5 };
  // タップ点がキューブ中心に来るよう N を置く（中心 = N + (p+q+r)/2）
  const N: Point2D = {
    x: tap.x - (p.x + q.x + r.x) / 2,
    y: tap.y - (p.y + q.y + r.y) / 2,
  };
  return { N, p, q, r };
}

/** 4点指定（手前の角 + 3方向の隣接頂点）からモデルを作る。 */
export function hexFromCorners(N: Point2D, alongP: Point2D, alongQ: Point2D, alongR: Point2D): HexModel {
  return { N: { ...N }, p: sub(alongP, N), q: sub(alongQ, N), r: sub(alongR, N) };
}
