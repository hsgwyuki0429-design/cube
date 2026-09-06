/**
 * 追跡用幾何ライブラリのテスト。
 * ここが狂うと追跡の全てが狂うので、既知の変換に対して数値で当てる。
 */
import { describe, it, expect } from 'vitest';
import {
  applyH, homographyFromCorrespondences, homographyFromQuad, quadFromHomography,
  reprojectionError, ransacHomography, mat3Mul, mat3Inverse, identity3, solveLinear,
  signedArea, quadArea, isConvex, aspectRatio, maxCornerJump, validateQuad,
  defaultQuadLimits, smoothQuad, quadCentroid,
  type Quad, type Mat3, type Point2D,
} from '../src/tracking/geometry';
import { makeRng } from '../src/core/cube';

const UNIT: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

function H(values: number[]): Mat3 {
  return Float64Array.from(values);
}

function corrFromH(h: Mat3, pts: [number, number][]): Float64Array {
  const out = new Float64Array(pts.length * 4);
  pts.forEach(([u, v], i) => {
    const p = applyH(h, u, v);
    out[i * 4] = u;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = p.x;
    out[i * 4 + 3] = p.y;
  });
  return out;
}

const GRID: [number, number][] = [];
for (let r = 0; r <= 3; r++) for (let c = 0; c <= 3; c++) GRID.push([c / 3, r / 3]);

describe('行列ユーティリティ', () => {
  it('単位行列との積は不変', () => {
    const a = H([1, 2, 3, 4, 5, 6, 7, 8, 1]);
    expect(Array.from(mat3Mul(a, identity3()))).toEqual(Array.from(a));
    expect(Array.from(mat3Mul(identity3(), a))).toEqual(Array.from(a));
  });

  it('逆行列との積は単位行列', () => {
    const a = H([2, 0.3, 5, -0.4, 1.7, 9, 0.001, 0.002, 1]);
    const inv = mat3Inverse(a)!;
    const p = mat3Mul(a, inv);
    for (let i = 0; i < 9; i++) expect(p[i]).toBeCloseTo(identity3()[i], 9);
  });

  it('特異行列は null', () => {
    expect(mat3Inverse(H([1, 2, 3, 2, 4, 6, 1, 1, 1]))).toBeNull();
  });

  it('連立方程式を解ける / 特異なら null', () => {
    const A = Float64Array.from([2, 1, -1, -3, -1, 2, -2, 1, 2]);
    const b = Float64Array.from([8, -11, -3]);
    const x = solveLinear(A, b, 3)!;
    expect(x[0]).toBeCloseTo(2, 9);
    expect(x[1]).toBeCloseTo(3, 9);
    expect(x[2]).toBeCloseTo(-1, 9);
    expect(solveLinear(Float64Array.from([1, 1, 2, 2]), Float64Array.from([1, 2]), 2)).toBeNull();
  });
});

describe('ホモグラフィ推定', () => {
  it('単位正方形（恒等）', () => {
    const h = homographyFromQuad(UNIT)!;
    for (const [u, v] of [[0.5, 0.5], [0.2, 0.9]]) {
      const p = applyH(h, u, v);
      expect(p.x).toBeCloseTo(u, 9);
      expect(p.y).toBeCloseTo(v, 9);
    }
  });

  it('平行移動', () => {
    const gt = H([1, 0, 120, 0, 1, -35, 0, 0, 1]);
    const est = homographyFromCorrespondences(corrFromH(gt, GRID), GRID.map((_, i) => i))!;
    expect(reprojectionError(est, corrFromH(gt, GRID), GRID.map((_, i) => i))).toBeLessThan(1e-8);
  });

  it('拡大縮小', () => {
    for (const s of [0.05, 1, 37, 400]) {
      const gt = H([s, 0, 10, 0, s, 20, 0, 0, 1]);
      const c = corrFromH(gt, GRID);
      const est = homographyFromCorrespondences(c, GRID.map((_, i) => i))!;
      expect(reprojectionError(est, c, GRID.map((_, i) => i)) / s).toBeLessThan(1e-8);
    }
  });

  it('回転', () => {
    for (const deg of [1, 15, 45, 90, 179]) {
      const a = (deg * Math.PI) / 180;
      const gt = H([Math.cos(a) * 200, -Math.sin(a) * 200, 300, Math.sin(a) * 200, Math.cos(a) * 200, 250, 0, 0, 1]);
      const c = corrFromH(gt, GRID);
      const est = homographyFromCorrespondences(c, GRID.map((_, i) => i))!;
      expect(reprojectionError(est, c, GRID.map((_, i) => i)), `${deg}deg`).toBeLessThan(1e-6);
    }
  });

  it('台形（射影）', () => {
    const q: Quad = [{ x: 100, y: 100 }, { x: 400, y: 130 }, { x: 360, y: 380 }, { x: 140, y: 350 }];
    const h = homographyFromQuad(q)!;
    const back = quadFromHomography(h);
    for (let i = 0; i < 4; i++) {
      expect(back[i].x).toBeCloseTo(q[i].x, 6);
      expect(back[i].y).toBeCloseTo(q[i].y, 6);
    }
  });

  it('極端な台形（奥行きが強い）でも復元する', () => {
    const q: Quad = [{ x: 10, y: 200 }, { x: 630, y: 60 }, { x: 620, y: 100 }, { x: 20, y: 230 }];
    const h = homographyFromQuad(q)!;
    const back = quadFromHomography(h);
    for (let i = 0; i < 4; i++) {
      expect(back[i].x).toBeCloseTo(q[i].x, 4);
      expect(back[i].y).toBeCloseTo(q[i].y, 4);
    }
  });

  it('退化した四角形（3点が同一）は null か非有限にならない', () => {
    const q: Quad = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 }];
    const h = homographyFromQuad(q);
    if (h) for (let i = 0; i < 9; i++) expect(Number.isFinite(h[i])).toBe(true);
  });

  it('4点未満は null', () => {
    expect(homographyFromCorrespondences(new Float64Array(12), [0, 1, 2])).toBeNull();
  });

  it('一般の射影行列を16点から完全復元する（100ケース）', () => {
    const rng = makeRng(1234);
    for (let t = 0; t < 100; t++) {
      const gt = H([
        150 + rng() * 200, (rng() - 0.5) * 80, rng() * 300,
        (rng() - 0.5) * 80, 150 + rng() * 200, rng() * 300,
        (rng() - 0.5) * 0.0015, (rng() - 0.5) * 0.0015, 1,
      ]);
      const c = corrFromH(gt, GRID);
      const idx = GRID.map((_, i) => i);
      const est = homographyFromCorrespondences(c, idx);
      expect(est).not.toBeNull();
      expect(reprojectionError(est!, c, idx)).toBeLessThan(1e-6);
    }
  });

  it('ノイズがあっても最小二乗で妥当な解になる', () => {
    const rng = makeRng(77);
    const gt = H([220, 20, 150, -15, 240, 90, 0.0004, -0.0002, 1]);
    const c = corrFromH(gt, GRID);
    for (let i = 0; i < GRID.length; i++) {
      c[i * 4 + 2] += (rng() - 0.5) * 1.5;
      c[i * 4 + 3] += (rng() - 0.5) * 1.5;
    }
    const idx = GRID.map((_, i) => i);
    const est = homographyFromCorrespondences(c, idx)!;
    expect(reprojectionError(est, c, idx)).toBeLessThan(1.0);
  });
});

describe('RANSAC', () => {
  const gt = H([210, 15, 160, -12, 205, 120, 0.0003, -0.0001, 1]);

  it('外れ値を含んでも正しいホモグラフィを取り出す', () => {
    const rng = makeRng(5);
    const c = corrFromH(gt, GRID);
    // 16点中5点を大きく壊す（追跡失敗・遮蔽を模す）
    for (const i of [1, 4, 7, 11, 14]) {
      c[i * 4 + 2] += 80 + rng() * 60;
      c[i * 4 + 3] -= 70 + rng() * 60;
    }
    const idx = GRID.map((_, i) => i);
    const r = ransacHomography(c, idx, { threshold: 3, iterations: 200, rng: makeRng(9) })!;
    expect(r).not.toBeNull();
    expect(r.inliers.length).toBe(11);
    for (const bad of [1, 4, 7, 11, 14]) expect(r.inliers).not.toContain(bad);
    expect(r.error).toBeLessThan(1e-5);
  });

  it('外れ値がなければ全点インライア', () => {
    const idx = GRID.map((_, i) => i);
    const r = ransacHomography(corrFromH(gt, GRID), idx, { rng: makeRng(3) })!;
    expect(r.inliers.length).toBe(GRID.length);
  });

  it('ちょうど4点なら直接解く', () => {
    const pts: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const r = ransacHomography(corrFromH(gt, pts), [0, 1, 2, 3], { rng: makeRng(1) })!;
    expect(r.inliers.length).toBe(4);
    expect(r.error).toBeLessThan(1e-8);
  });

  it('4点未満は null', () => {
    expect(ransacHomography(new Float64Array(12), [0, 1, 2])).toBeNull();
  });
});

describe('四角形の妥当性', () => {
  const sq: Quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];

  it('面積・凸性・アスペクト・重心', () => {
    expect(quadArea(sq)).toBeCloseTo(10000, 9);
    expect(signedArea(sq)).toBeGreaterThan(0);
    expect(isConvex(sq)).toBe(true);
    expect(aspectRatio(sq)).toBeCloseTo(1, 9);
    expect(quadCentroid(sq)).toEqual({ x: 50, y: 50 });
  });

  it('自己交差（蝶形）は凸でない', () => {
    const bow: Quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }];
    expect(isConvex(bow)).toBe(false);
    expect(validateQuad(bow, defaultQuadLimits()).reasons).toContain('concave');
  });

  it('凹四角形を弾く', () => {
    // (40,40) は (100,0)-(0,100) の内側なので本当に凹。(50,50) だと共線で凹にならない。
    const concave: Quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 100 }];
    expect(isConvex(concave)).toBe(false);
    expect(validateQuad(concave, defaultQuadLimits()).reasons).toContain('concave');
  });

  it('小さすぎ / 潰れすぎを弾く', () => {
    const tiny: Quad = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }];
    expect(validateQuad(tiny, defaultQuadLimits()).reasons).toContain('too-small');
    const flat: Quad = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 8 }, { x: 0, y: 8 }];
    expect(validateQuad(flat, defaultQuadLimits()).reasons).toContain('degenerate-aspect');
  });

  it('前フレームからの面積急変・頂点ジャンプ・巻き方向反転を弾く', () => {
    const big: Quad = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 }];
    expect(validateQuad(big, defaultQuadLimits(), sq).reasons).toContain('area-jump');

    const moved: Quad = sq.map((p) => ({ x: p.x + 200, y: p.y })) as Quad;
    expect(validateQuad(moved, defaultQuadLimits(), sq).reasons).toContain('corner-jump');

    const flipped: Quad = [sq[0], sq[3], sq[2], sq[1]];
    expect(validateQuad(flipped, defaultQuadLimits(), sq).reasons).toContain('winding-flip');
  });

  it('小さな移動は通す（追従を妨げない）', () => {
    const moved: Quad = sq.map((p) => ({ x: p.x + 6, y: p.y - 4 })) as Quad;
    expect(validateQuad(moved, defaultQuadLimits(), sq).ok).toBe(true);
  });

  it('非有限座標は即座に弾く', () => {
    const bad: Quad = [{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    expect(validateQuad(bad, defaultQuadLimits()).ok).toBe(false);
  });

  it('maxCornerJump は最大移動量', () => {
    const moved: Quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 3, y: 4 }];
    expect(maxCornerJump(sq, moved)).toBeCloseTo(Math.hypot(3, 96), 9);
  });

  it('smoothQuad は alpha=1 で next、alpha=0 で prev', () => {
    const next: Quad = sq.map((p) => ({ x: p.x + 10, y: p.y })) as Quad;
    expect(smoothQuad(sq, next, 1)).toEqual(next);
    expect(smoothQuad(sq, next, 0)).toEqual(sq);
    expect(smoothQuad(sq, next, 0.5)[1].x).toBeCloseTo(105, 9);
  });
});

describe('セル中心の射影', () => {
  it('9セルの中心が正しい位置に来る（軸並行）', () => {
    const q: Quad = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 }];
    const h = homographyFromQuad(q)!;
    const expected = [50, 150, 250];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const p = applyH(h, (c * 2 + 1) / 6, (r * 2 + 1) / 6);
        expect(p.x).toBeCloseTo(expected[c], 6);
        expect(p.y).toBeCloseTo(expected[r], 6);
      }
    }
  });

  it('台形でも9セル中心が四角形の内側に収まる', () => {
    const q: Quad = [{ x: 40, y: 60 }, { x: 380, y: 20 }, { x: 420, y: 300 }, { x: 10, y: 330 }];
    const h = homographyFromQuad(q)!;
    const pts: Point2D[] = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) pts.push(applyH(h, (c * 2 + 1) / 6, (r * 2 + 1) / 6));
    const xs = q.map((p) => p.x);
    const ys = q.map((p) => p.y);
    for (const p of pts) {
      expect(p.x).toBeGreaterThan(Math.min(...xs) - 1);
      expect(p.x).toBeLessThan(Math.max(...xs) + 1);
      expect(p.y).toBeGreaterThan(Math.min(...ys) - 1);
      expect(p.y).toBeLessThan(Math.max(...ys) + 1);
    }
  });

  it('頂点順を回しても、対応する (u,v) を回せば同じ点に落ちる', () => {
    const q: Quad = [{ x: 40, y: 60 }, { x: 380, y: 20 }, { x: 420, y: 300 }, { x: 10, y: 330 }];
    const rotated: Quad = [q[3], q[0], q[1], q[2]];
    const h = homographyFromQuad(q)!;
    const hr = homographyFromQuad(rotated)!;
    // rotated = [q3,q0,q1,q2] なので、回した系の (u',v') は元の (u,v) = (v', 1-u')。
    // 逆に解くと u' = 1-v, v' = u。
    const u = 0.25;
    const v = 0.75;
    const p = applyH(h, u, v);
    const pr = applyH(hr, 1 - v, u);
    expect(pr.x).toBeCloseTo(p.x, 4);
    expect(pr.y).toBeCloseTo(p.y, 4);
  });
});
