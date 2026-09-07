/**
 * 追跡用の幾何ライブラリ。
 *
 * 純粋関数のみ。カメラも DOM も Worker も知らない（CLAUDE.md アーキテクチャ原則 §1）。
 * 既存の src/vision/homography.ts は「単位正方形 → 四角形」の閉形式解で、
 * ROI サンプリング用。こちらは「N点対応 → ホモグラフィ」を扱う。用途が違うので併存させる。
 */

export interface Point2D {
  x: number;
  y: number;
}

/** 四角形。(0,0)->q[0], (1,0)->q[1], (1,1)->q[2], (0,1)->q[3] の順。既存 ROI と同じ規約。 */
export type Quad = [Point2D, Point2D, Point2D, Point2D];

/** 行優先 3x3 行列。 */
export type Mat3 = Float64Array;

export function mat3(): Mat3 {
  return new Float64Array(9);
}

export function identity3(): Mat3 {
  const m = mat3();
  m[0] = m[4] = m[8] = 1;
  return m;
}

export function mat3Mul(a: Mat3, b: Mat3, out: Mat3 = mat3()): Mat3 {
  const r = out === a || out === b ? mat3() : out;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  if (r !== out) out.set(r);
  return out;
}

export function mat3Inverse(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  const out = mat3();
  out[0] = A * inv;
  out[1] = -(b * i - c * h) * inv;
  out[2] = (b * f - c * e) * inv;
  out[3] = B * inv;
  out[4] = (a * i - c * g) * inv;
  out[5] = -(a * f - c * d) * inv;
  out[6] = C * inv;
  out[7] = -(a * h - b * g) * inv;
  out[8] = (a * e - b * d) * inv;
  return out;
}

/** 射影変換で点を写す。 */
export function applyH(m: Mat3, x: number, y: number, out: Point2D = { x: 0, y: 0 }): Point2D {
  const w = m[6] * x + m[7] * y + m[8];
  if (Math.abs(w) < 1e-12) {
    out.x = NaN;
    out.y = NaN;
    return out;
  }
  out.x = (m[0] * x + m[1] * y + m[2]) / w;
  out.y = (m[3] * x + m[4] * y + m[5]) / w;
  return out;
}

// ---------------------------------------------------------------------------
// 線形代数（小さい密行列の最小二乗）
// ---------------------------------------------------------------------------

/**
 * n x n の連立一次方程式を部分ピボット付きガウス消去で解く。
 * A は行優先で破壊的に使う。解けなければ null。
 */
export function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const M = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(M[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r * n + col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-13) return null;
    if (piv !== col) {
      for (let k = 0; k < n; k++) {
        const t = M[col * n + k];
        M[col * n + k] = M[piv * n + k];
        M[piv * n + k] = t;
      }
      const t = x[col];
      x[col] = x[piv];
      x[piv] = t;
    }
    const d = M[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r * n + col] / d;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) M[r * n + k] -= factor * M[col * n + k];
      x[r] -= factor * x[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) return null;
  return x;
}

// ---------------------------------------------------------------------------
// ホモグラフィ推定
// ---------------------------------------------------------------------------

/** Hartley 正規化。重心を原点に、平均距離を sqrt(2) に。 */
function normalizePoints(pts: ArrayLike<number>, idx: number[], offset: number): { T: Mat3; Ti: Mat3 } {
  let cx = 0;
  let cy = 0;
  for (const i of idx) {
    cx += pts[i * 4 + offset];
    cy += pts[i * 4 + offset + 1];
  }
  cx /= idx.length;
  cy /= idx.length;
  let d = 0;
  for (const i of idx) {
    d += Math.hypot(pts[i * 4 + offset] - cx, pts[i * 4 + offset + 1] - cy);
  }
  d /= idx.length;
  const s = d > 1e-9 ? Math.SQRT2 / d : 1;
  const T = mat3();
  T[0] = s; T[2] = -s * cx;
  T[4] = s; T[5] = -s * cy;
  T[8] = 1;
  const Ti = mat3();
  Ti[0] = 1 / s; Ti[2] = cx;
  Ti[4] = 1 / s; Ti[5] = cy;
  Ti[8] = 1;
  return { T, Ti };
}

/**
 * N 点対応からホモグラフィを推定する（正規化 DLT + 非同次最小二乗）。
 *
 * corr は [srcX, srcY, dstX, dstY] を並べた配列。idx で使う対応を選ぶ。
 * h33 = 1 と置いた 8 未知数の線形最小二乗を正規方程式で解く。
 * SVD を持ち込まずに済むぶん実装が小さく、この用途（h33 != 0 が保証される
 * 通常のカメラ視点）では精度も十分。
 */
export function homographyFromCorrespondences(
  corr: ArrayLike<number>,
  idx: number[],
): Mat3 | null {
  if (idx.length < 4) return null;
  const { T: Ts } = normalizePoints(corr, idx, 0);
  const { T: Td, Ti: Tdi } = normalizePoints(corr, idx, 2);

  const A = new Float64Array(64);
  const rhs = new Float64Array(8);
  const row = new Float64Array(8);
  const p: Point2D = { x: 0, y: 0 };
  const q: Point2D = { x: 0, y: 0 };

  const accumulate = (r: Float64Array, target: number) => {
    for (let i = 0; i < 8; i++) {
      rhs[i] += r[i] * target;
      for (let j = 0; j < 8; j++) A[i * 8 + j] += r[i] * r[j];
    }
  };

  for (const i of idx) {
    applyH(Ts, corr[i * 4], corr[i * 4 + 1], p);
    applyH(Td, corr[i * 4 + 2], corr[i * 4 + 3], q);
    row.fill(0);
    row[0] = p.x; row[1] = p.y; row[2] = 1; row[6] = -p.x * q.x; row[7] = -p.y * q.x;
    accumulate(row, q.x);
    row.fill(0);
    row[3] = p.x; row[4] = p.y; row[5] = 1; row[6] = -p.x * q.y; row[7] = -p.y * q.y;
    accumulate(row, q.y);
  }

  const h = solveLinear(A, rhs, 8);
  if (!h) return null;
  const Hn = mat3();
  Hn[0] = h[0]; Hn[1] = h[1]; Hn[2] = h[2];
  Hn[3] = h[3]; Hn[4] = h[4]; Hn[5] = h[5];
  Hn[6] = h[6]; Hn[7] = h[7]; Hn[8] = 1;

  // H = Td^-1 * Hn * Ts
  const H = mat3Mul(Tdi, mat3Mul(Hn, Ts));
  if (Math.abs(H[8]) > 1e-12) for (let i = 0; i < 9; i++) H[i] /= H[8];
  for (let i = 0; i < 9; i++) if (!Number.isFinite(H[i])) return null;
  return H;
}

/** 単位正方形 -> 四角形。既存 vision/homography.ts と同じ対応規約。 */
export function homographyFromQuad(q: Quad): Mat3 | null {
  const corr = new Float64Array([
    0, 0, q[0].x, q[0].y,
    1, 0, q[1].x, q[1].y,
    1, 1, q[2].x, q[2].y,
    0, 1, q[3].x, q[3].y,
  ]);
  return homographyFromCorrespondences(corr, [0, 1, 2, 3]);
}

/** ホモグラフィ -> 四角形（単位正方形の4隅を写す）。 */
export function quadFromHomography(H: Mat3): Quad {
  return [
    applyH(H, 0, 0),
    applyH(H, 1, 0),
    applyH(H, 1, 1),
    applyH(H, 0, 1),
  ];
}

/** 対応点集合に対する平均再投影誤差（px）。 */
export function reprojectionError(H: Mat3, corr: ArrayLike<number>, idx: number[]): number {
  if (!idx.length) return Infinity;
  const p: Point2D = { x: 0, y: 0 };
  let s = 0;
  for (const i of idx) {
    applyH(H, corr[i * 4], corr[i * 4 + 1], p);
    s += Math.hypot(p.x - corr[i * 4 + 2], p.y - corr[i * 4 + 3]);
  }
  return s / idx.length;
}

export interface RansacResult {
  H: Mat3;
  inliers: number[];
  error: number;
}

/**
 * RANSAC でホモグラフィを推定する。外れ値（追跡に失敗した点、手で隠れた点）を落とす。
 * 決定的にしたいので rng を差し込めるようにしてある（テストで固定する）。
 */
export function ransacHomography(
  corr: ArrayLike<number>,
  idx: number[],
  opts: { threshold?: number; iterations?: number; rng?: () => number } = {},
): RansacResult | null {
  const threshold = opts.threshold ?? 3;
  const rng = opts.rng ?? Math.random;
  if (idx.length < 4) return null;
  if (idx.length === 4) {
    const H = homographyFromCorrespondences(corr, idx);
    if (!H) return null;
    return { H, inliers: idx.slice(), error: reprojectionError(H, corr, idx) };
  }

  const iterations = opts.iterations ?? 40;
  const p: Point2D = { x: 0, y: 0 };
  let best: RansacResult | null = null;

  const pick4 = (): number[] => {
    const out: number[] = [];
    let guard = 0;
    while (out.length < 4 && guard++ < 100) {
      const c = idx[Math.floor(rng() * idx.length)];
      if (!out.includes(c)) out.push(c);
    }
    return out;
  };

  for (let it = 0; it < iterations; it++) {
    const sample = pick4();
    if (sample.length < 4) continue;
    const H = homographyFromCorrespondences(corr, sample);
    if (!H) continue;
    const inliers: number[] = [];
    for (const i of idx) {
      applyH(H, corr[i * 4], corr[i * 4 + 1], p);
      if (Math.hypot(p.x - corr[i * 4 + 2], p.y - corr[i * 4 + 3]) <= threshold) inliers.push(i);
    }
    if (inliers.length >= 4 && (!best || inliers.length > best.inliers.length)) {
      best = { H, inliers, error: reprojectionError(H, corr, inliers) };
      if (inliers.length === idx.length) break;
    }
  }
  if (!best) return null;

  // インライアで再フィット（サンプル4点だけの解より安定する）
  const refined = homographyFromCorrespondences(corr, best.inliers);
  if (refined) {
    const err = reprojectionError(refined, corr, best.inliers);
    if (err <= best.error) return { H: refined, inliers: best.inliers, error: err };
  }
  return best;
}

// ---------------------------------------------------------------------------
// 四角形の妥当性
// ---------------------------------------------------------------------------

/** 符号付き面積（画像座標系なので正 = 時計回り）。 */
export function signedArea(q: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function quadArea(q: Quad): number {
  return Math.abs(signedArea(q));
}

export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return sign !== 0;
}

/** 最短辺 / 最長辺。極端に潰れた四角形を弾くのに使う。 */
export function aspectRatio(q: Quad): number {
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(q[(i + 1) % 4].x - q[i].x, q[(i + 1) % 4].y - q[i].y);
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return max > 0 ? min / max : 0;
}

export function quadCentroid(q: Quad): Point2D {
  return {
    x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
    y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
  };
}

/** 対応する頂点同士の最大移動量（px）。急なジャンプの検出に使う。 */
export function maxCornerJump(a: Quad, b: Quad): number {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  return m;
}

export interface QuadValidation {
  ok: boolean;
  reasons: string[];
}

export interface QuadLimits {
  minArea: number;
  maxArea: number;
  /** 前フレームからの面積比の許容範囲（1フレームぶん） */
  maxAreaRatio: number;
  /** 前フレームからの頂点移動量の上限（px） */
  maxJump: number;
  /** 最短辺/最長辺 の下限 */
  minAspect: number;
}

export function defaultQuadLimits(): QuadLimits {
  // 60fps では1フレームで面積が 35% も変わることはない。1.8 だと毎フレーム倍増を許してしまう
  return { minArea: 200, maxArea: 1e7, maxAreaRatio: 1.35, maxJump: 60, minAspect: 0.25 };
}

/**
 * 四角形が使える形かを判定する。prev があればフレーム間の連続性も見る。
 * 「1フレームだけ頂点が飛んだ」ものをそのまま採用しないための関門。
 */
export function validateQuad(q: Quad, limits: QuadLimits, prev?: Quad | null): QuadValidation {
  const reasons: string[] = [];
  for (const p of q) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return { ok: false, reasons: ['non-finite'] };
    }
  }
  if (!isConvex(q)) reasons.push('concave');
  const area = quadArea(q);
  if (area < limits.minArea) reasons.push('too-small');
  if (area > limits.maxArea) reasons.push('too-large');
  if (aspectRatio(q) < limits.minAspect) reasons.push('degenerate-aspect');
  if (prev) {
    const prevArea = quadArea(prev);
    if (prevArea > 0) {
      const ratio = area / prevArea;
      if (ratio > limits.maxAreaRatio || ratio < 1 / limits.maxAreaRatio) reasons.push('area-jump');
    }
    if (signedArea(q) * signedArea(prev) < 0) reasons.push('winding-flip');
    if (maxCornerJump(q, prev) > limits.maxJump) reasons.push('corner-jump');
  }
  return { ok: reasons.length === 0, reasons };
}

/** 四角形の指数移動平均。追従遅延を増やしすぎないよう alpha は大きめに使う。 */
export function smoothQuad(prev: Quad, next: Quad, alpha: number): Quad {
  const out = [] as unknown as Quad;
  for (let i = 0; i < 4; i++) {
    out[i] = {
      x: prev[i].x + alpha * (next[i].x - prev[i].x),
      y: prev[i].y + alpha * (next[i].y - prev[i].y),
    };
  }
  return out;
}

/**
 * 2本のベクトルの対応 (a0->b0, a1->b1) から 2x2 線形変換 [m0 m1; m2 m3] を解く。
 * 隠れた面を剛体的に予測するのに使う。
 */
export function solve2x2Map(a0: Point2D, a1: Point2D, b0: Point2D, b1: Point2D): [number, number, number, number] | null {
  const det = a0.x * a1.y - a0.y * a1.x;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  // [m0 m1] * [a0.x a1.x; a0.y a1.y] = [b0.x b1.x]
  const m0 = (b0.x * a1.y - b1.x * a0.y) / det;
  const m1 = (a0.x * b1.x - a1.x * b0.x) / det;
  const m2 = (b0.y * a1.y - b1.y * a0.y) / det;
  const m3 = (a0.x * b1.y - a1.x * b0.y) / det;
  const out: [number, number, number, number] = [m0, m1, m2, m3];
  return out.every(Number.isFinite) ? out : null;
}

export function cloneQuad(q: Quad): Quad {
  return [{ x: q[0].x, y: q[0].y }, { x: q[1].x, y: q[1].y }, { x: q[2].x, y: q[2].y }, { x: q[3].x, y: q[3].y }];
}
