/**
 * オプティカルフローのテスト。既知の変位を与えて px 単位で当てる。
 */
import { describe, it, expect } from 'vitest';
import {
  rgbaToGray, buildPyramid, downsample, sampleBilinear, trackPoints,
  defaultFlowOptions, createGray, type GrayImage,
} from '../src/tracking/opticalFlow';
import { renderFrame, defaultCamera, defaultPose } from '../src/dev/cubeRender';
import { homographyFromQuad, applyH } from '../src/tracking/geometry';
import { makeRng } from '../src/core/cube';

/** テクスチャのある合成画像。 */
function texture(w: number, h: number, dx = 0, dy = 0): GrayImage {
  const img = createGray(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x - dx;
      const v = y - dy;
      // 高周波と低周波を混ぜる。単純な市松だと開口問題が出る
      const val = 128
        + 60 * Math.sin(u * 0.31) * Math.cos(v * 0.27)
        + 40 * Math.sin((u + v) * 0.13)
        + 25 * Math.cos(u * 0.07 - v * 0.11);
      img.data[y * w + x] = Math.max(0, Math.min(255, val));
    }
  }
  return img;
}

/** 周期を持たない滑らかな値ノイズ。エイリアスを避けたいテスト用。 */
function valueNoise(w: number, h: number, dx = 0, dy = 0): GrayImage {
  const img = createGray(w, h);
  const cell = 9;
  const rng = makeRng(20260906);
  const gw = Math.ceil((w + 400) / cell) + 2;
  const gh = Math.ceil((h + 400) / cell) + 2;
  const lattice = new Float32Array(gw * gh);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng() * 255;
  const at = (gx: number, gy: number) =>
    lattice[Math.min(gh - 1, Math.max(0, gy)) * gw + Math.min(gw - 1, Math.max(0, gx))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x - dx) / cell + 20;
      const v = (y - dy) / cell + 20;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      img.data[y * w + x] = Math.max(0, Math.min(255, a + (b - a) * sy));
    }
  }
  return img;
}

const gray = (f: ReturnType<typeof renderFrame>) => rgbaToGray(f.rgba, f.width, f.height);

describe('画像ユーティリティ', () => {
  it('RGBA -> グレースケール', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const g = rgbaToGray(rgba, 2, 1);
    expect(g.data[0]).toBeGreaterThan(250);
    expect(g.data[1]).toBe(0);
  });

  it('縮小で寸法が半分になる', () => {
    const g = createGray(64, 48);
    const d = downsample(g);
    expect([d.width, d.height]).toEqual([32, 24]);
  });

  it('ピラミッドは指定段数まで、小さくなりすぎたら止まる', () => {
    expect(buildPyramid(createGray(320, 240), 4).length).toBe(4);
    expect(buildPyramid(createGray(30, 30), 4).length).toBe(2);
  });

  it('バイリニア補間は格子点で元の値、範囲外はクランプ', () => {
    const g = createGray(2, 2);
    g.data.set([0, 100, 200, 255]);
    expect(sampleBilinear(g, 0, 0)).toBe(0);
    expect(sampleBilinear(g, 1, 0)).toBe(100);
    expect(sampleBilinear(g, 0.5, 0)).toBeCloseTo(50, 6);
    expect(sampleBilinear(g, -5, -5)).toBe(0);
    expect(sampleBilinear(g, 99, 99)).toBe(255);
  });
});

describe('Lucas-Kanade 追跡', () => {
  const opts = defaultFlowOptions();

  it('平行移動を 0.15px 以内で当てる', () => {
    for (const [dx, dy] of [[1, 0], [0, 1], [3, -2], [-5, 4], [7, 7], [-9, 2]]) {
      const a = buildPyramid(texture(240, 200), 3);
      const b = buildPyramid(texture(240, 200, dx, dy), 3);
      const pts = [80, 70, 120, 100, 160, 130, 100, 150];
      const res = trackPoints(a, b, pts, opts);
      for (let i = 0; i < res.length; i++) {
        expect(res[i].ok, `d=${dx},${dy} p${i}`).toBe(true);
        expect(res[i].x - pts[i * 2], `dx ${dx},${dy}`).toBeCloseTo(dx, 1);
        expect(res[i].y - pts[i * 2 + 1], `dy ${dx},${dy}`).toBeCloseTo(dy, 1);
      }
    }
  });

  it('サブピクセル変位も追える', () => {
    const a = buildPyramid(texture(200, 200), 3);
    const b = buildPyramid(texture(200, 200, 0.4, -0.7), 3);
    const res = trackPoints(a, b, [100, 100], opts);
    expect(res[0].ok).toBe(true);
    expect(res[0].x - 100).toBeCloseTo(0.4, 1);
    expect(res[0].y - 100).toBeCloseTo(-0.7, 1);
  });

  it('ピラミッドにより大きな変位も追える（15px）', () => {
    const a = buildPyramid(texture(300, 300), 4);
    const b = buildPyramid(texture(300, 300, 15, -12), 4);
    const res = trackPoints(a, b, [150, 150], { ...opts, levels: 4 });
    expect(res[0].ok).toBe(true);
    expect(res[0].x - 150).toBeCloseTo(15, 0);
    expect(res[0].y - 150).toBeCloseTo(-12, 0);
  });

  it('テクスチャのない領域は ok=false になる（無理に追わない）', () => {
    const flat = createGray(120, 120);
    flat.data.fill(128);
    const a = buildPyramid(flat, 3);
    const b = buildPyramid(flat, 3);
    const res = trackPoints(a, b, [60, 60], opts);
    expect(res[0].ok).toBe(false);
    expect(res[0].eigen).toBeLessThan(opts.minEigenvalue);
  });

  it('内容が全く違う画像では残差が大きく ok=false', () => {
    const a = buildPyramid(texture(160, 160), 3);
    const noise = createGray(160, 160);
    const rng = makeRng(4);
    for (let i = 0; i < noise.data.length; i++) noise.data[i] = rng() * 255;
    const res = trackPoints(a, buildPyramid(noise, 3), [80, 80], opts);
    expect(res[0].ok).toBe(false);
  });

  it('画像外の点は追跡しない', () => {
    const a = buildPyramid(texture(120, 120), 3);
    const b = buildPyramid(texture(120, 120, 2, 2), 3);
    for (const [x, y] of [[-40, -40], [200, 60], [60, 400]]) {
      expect(trackPoints(a, b, [x, y], opts)[0].ok, `${x},${y}`).toBe(false);
    }
  });

  it('全面が平坦になったら ok=false', () => {
    const a = buildPyramid(valueNoise(140, 140), 3);
    const flat = createGray(140, 140);
    flat.data.fill(200);
    expect(trackPoints(a, buildPyramid(flat, 3), [70, 70], opts)[0].ok).toBe(false);
  });

  it('局所的な遮蔽では LK 単体は誤マッチへ流れうる（RANSAC と幾何検証が必要な理由）', () => {
    // 点の周りだけ塗り潰すと、近傍の残っているテクスチャに吸着して
    // 「残差は小さいが位置は間違い」という結果になりうる。
    // 点ごとの残差だけでは守れないので、上位で幾何整合性を見る必要がある。
    const a = buildPyramid(valueNoise(140, 140), 3);
    const occluded = valueNoise(140, 140);
    for (let y = 40; y < 110; y++) for (let x = 40; x < 110; x++) occluded.data[y * 140 + x] = 200;
    const r = trackPoints(a, buildPyramid(occluded, 3), [70, 70], opts)[0];
    const drift = Math.hypot(r.x - 70, r.y - 70);
    // 棄却されるか、さもなくば大きくずれる。「小さくずれて成功扱い」にはならないこと
    expect(!r.ok || drift > 5).toBe(true);
  });
});

describe('合成キューブ映像上での追跡', () => {
  it('レンダリング結果に3面が見えており、四角形が凸', () => {
    const cam = defaultCamera();
    const f = renderFrame(defaultPose(), cam);
    const visible = f.faces.filter((x) => x.visible);
    expect(visible.length).toBe(3);
    expect(visible.map((x) => x.id).sort()).toEqual(['F', 'R', 'U']);
    for (const face of visible) {
      for (const p of face.quad) {
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(cam.width);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThan(cam.height);
      }
      expect(face.cellCenters.length).toBe(9);
    }
  });

  it('ステッカー中央は単色なので追跡できない（特徴点の置き方が決まる根拠）', () => {
    const cam = defaultCamera();
    const p0 = defaultPose();
    const f0 = renderFrame(p0, cam);
    const f1 = renderFrame({ ...p0, tx: p0.tx + 0.06 }, cam);
    const a = buildPyramid(gray(f0), 3);
    const b = buildPyramid(gray(f1), 3);
    const pts: number[] = [];
    for (const face of f0.faces.filter((x) => x.visible)) {
      for (const c of face.cellCenters) pts.push(c.x, c.y);
    }
    const ok = trackPoints(a, b, pts, defaultFlowOptions()).filter((r) => r.ok).length;
    // 単色領域が多いので大半は追跡不能。ここを無理に追うと誤追跡になる
    expect(ok).toBeLessThan(pts.length / 2 * 0.5);
  });

  it('ステッカー境界の交点は特徴点として追跡できる', () => {
    const cam = defaultCamera();
    const p0 = defaultPose();
    const p1 = { ...p0, tx: p0.tx + 0.06, ty: p0.ty + 0.03 };
    const f0 = renderFrame(p0, cam);
    const f1 = renderFrame(p1, cam);
    const a = buildPyramid(gray(f0), 3);
    const b = buildPyramid(gray(f1), 3);

    // u,v ∈ {0, 1/3, 2/3, 1} の 4x4 格子 = 黒い枠線の交点・T字部・面の角。
    // どれも2方向に勾配があるので LK が解ける（開口問題が出ない）。
    const gt0 = f0.faces.filter((x) => x.visible);
    const gt1 = f1.faces.filter((x) => x.visible);
    const uv: [number, number][] = [];
    for (const v of [0, 1 / 3, 2 / 3, 1]) for (const u of [0, 1 / 3, 2 / 3, 1]) uv.push([u, v]);
    const pts: number[] = [];
    const truth: number[] = [];
    gt0.forEach((face, fi) => {
      const h0 = homographyFromQuad(face.quad)!;
      const h1 = homographyFromQuad(gt1[fi].quad)!;
      for (const [u, v] of uv) {
        const p = applyH(h0, u, v);
        const q = applyH(h1, u, v);
        pts.push(p.x, p.y);
        truth.push(q.x, q.y);
      }
    });

    const res = trackPoints(a, b, pts, defaultFlowOptions());
    const okCount = res.filter((r) => r.ok).length;
    expect(okCount).toBeGreaterThanOrEqual(res.length * 0.6);
    let err = 0;
    let n = 0;
    res.forEach((r, i) => {
      if (!r.ok) return;
      err += Math.hypot(r.x - truth[i * 2], r.y - truth[i * 2 + 1]);
      n++;
    });
    expect(err / n).toBeLessThan(2.5);
  });
});
