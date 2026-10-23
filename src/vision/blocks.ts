// ステッカーレスキューブ対策: 同じ色のタイルが隣り合うと境界が消え、2x1・3x3 などの「ブロック」として
// 1つの四角形に見える。直前のフレームで見つかった面の格子（射影変換）でブロックの大きさを測り、
// n×m 個の仮想ステッカーに分割して、通常の格子当てはめに渡す。
import { type Mat3, type Pt, applyH, invertH } from "./homography";
import { type Quad, pointInPolygon } from "./lattice";

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return Math.abs(a) / 2;
}

export function expandBlocks(quads: Quad[], faces: Mat3[], shrink = 0.9): Quad[] {
  if (!faces.length) return quads;
  const inverses = faces.map(invertH);
  const out: Quad[] = [];
  for (const q of quads) {
    // このブロックが乗っている面（直前のフレーム）
    let fi = -1;
    for (let i = 0; i < faces.length && fi < 0; i++) {
      const [u, v] = applyH(inverses[i], q.center[0], q.center[1]);
      if (u > -0.2 && u < 3.2 && v > -0.2 && v < 3.2) fi = i;
    }
    if (fi < 0) {
      out.push(q);
      continue;
    }
    const lat = q.corners.map((c) => applyH(inverses[fi], c[0], c[1]));
    const us = lat.map((p) => p[0]);
    const vs = lat.map((p) => p[1]);
    const du = Math.max(...us) - Math.min(...us);
    const dv = Math.max(...vs) - Math.min(...vs);
    const n = Math.round(du);
    const m = Math.round(dv);
    const fits = (d: number, k: number) => k >= 1 && k <= 3 && Math.abs(d - k) < 0.3;
    const inside = quads.filter((o) => o !== q && pointInPolygon(o.center, q.corners)).length;
    if (!fits(du, n) || !fits(dv, m) || (n === 1 && m === 1) || inside >= 2) {
      out.push(q);
      continue;
    }
    // 格子の向きに合わせて四隅を並べる: (u小,v小) (u大,v小) (u大,v大) (u小,v大)
    const pick = (su: number, sv: number) => {
      let best = 0;
      let bestScore = -Infinity;
      lat.forEach(([u, v], i) => {
        const s = su * u + sv * v;
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      });
      return q.corners[best];
    };
    const c00 = pick(-1, -1);
    const c10 = pick(1, -1);
    const c11 = pick(1, 1);
    const c01 = pick(-1, 1);
    const at = (a: number, b: number) => lerp(lerp(c00, c10, a), lerp(c01, c11, a), b);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        const c = at((i + 0.5) / n, (j + 0.5) / m);
        const corners = [at(i / n, j / m), at((i + 1) / n, j / m), at((i + 1) / n, (j + 1) / m), at(i / n, (j + 1) / m)].map((p) => lerp(c, p, shrink));
        out.push({ center: c, corners, area: polygonArea(corners) });
      }
    }
  }
  return out;
}

// 最初の1枚（直前の面なし）で、面全体が1色のときの救済用の候補
export function largeFaceCandidates(quads: Quad[], frameArea: number): Quad[] {
  return quads.filter((q) => q.area > frameArea / 45 && q.area < frameArea / 3);
}
