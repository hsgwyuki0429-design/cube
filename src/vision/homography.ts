/**
 * 4隅 → 単位正方形 の射影変換（ホモグラフィ）。
 *
 * バイリニア補間ではなく正しい射影変換であること。斜めから見た面では
 * バイリニアだとグリッドがずれてセル中心が隣のステッカーに落ちる。
 *
 * 実装は Heckbert の単位正方形→四角形の閉形式解。
 * 対応: (0,0)->c0, (1,0)->c1, (1,1)->c2, (0,1)->c3
 */

export interface Pt {
  x: number;
  y: number;
}

/** (u,v) -> (x,y) の射影変換係数。 */
export interface Homography {
  a: number; b: number; c: number;
  d: number; e: number; f: number;
  g: number; h: number;
}

export function computeHomography(corners: readonly [Pt, Pt, Pt, Pt]): Homography {
  const [p0, p1, p2, p3] = corners;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;

  // アフィン（平行四辺形）の縮退ケース
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    return {
      a: p1.x - p0.x, b: p2.x - p1.x, c: p0.x,
      d: p1.y - p0.y, e: p2.y - p1.y, f: p0.y,
      g: 0, h: 0,
    };
  }

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const det = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(det) < 1e-12) throw new Error('degenerate quad: cannot compute homography');

  const g = (sx * dy2 - sy * dx2) / det;
  const h = (dx1 * sy - dy1 * sx) / det;
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

/** 単位正方形上の点 (u,v) を四角形内の点へ写す。 */
export function mapPoint(H: Homography, u: number, v: number, out: Pt = { x: 0, y: 0 }): Pt {
  const w = H.g * u + H.h * v + 1;
  out.x = (H.a * u + H.b * v + H.c) / w;
  out.y = (H.d * u + H.e * v + H.f) / w;
  return out;
}

/** 四角形が凸で自己交差していないか（ROI が破綻していないかの判定用）。 */
export function isConvexQuad(corners: readonly [Pt, Pt, Pt, Pt]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return sign !== 0;
}
