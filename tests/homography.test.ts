import { describe, it, expect } from 'vitest';
import { computeHomography, mapPoint, isConvexQuad, type Pt } from '../src/vision/homography';
import { makeRng } from '../src/core/cube';

/** 参照実装: 一般の3x3射影行列で点を写す。 */
function project(M: number[], u: number, v: number): Pt {
  const w = M[6] * u + M[7] * v + M[8];
  return { x: (M[0] * u + M[1] * v + M[2]) / w, y: (M[3] * u + M[4] * v + M[5]) / w };
}

describe('ホモグラフィ', () => {
  it('4隅が単位正方形の頂点に正確に対応する', () => {
    const corners: [Pt, Pt, Pt, Pt] = [
      { x: 100, y: 50 }, { x: 400, y: 90 }, { x: 380, y: 330 }, { x: 60, y: 300 },
    ];
    const H = computeHomography(corners);
    const uv: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 4; i++) {
      const p = mapPoint(H, uv[i][0], uv[i][1]);
      expect(p.x).toBeCloseTo(corners[i].x, 9);
      expect(p.y).toBeCloseTo(corners[i].y, 9);
    }
  });

  it('任意の射影行列を4隅から完全に復元する（内部の点まで一致）', () => {
    const rng = makeRng(20260906);
    for (let trial = 0; trial < 200; trial++) {
      // 適当な非退化の射影行列を作る
      const M = [
        1 + rng(), rng() - 0.5, rng() * 100,
        rng() - 0.5, 1 + rng(), rng() * 100,
        (rng() - 0.5) * 0.4, (rng() - 0.5) * 0.4, 1,
      ];
      const corners = [project(M, 0, 0), project(M, 1, 0), project(M, 1, 1), project(M, 0, 1)] as
        [Pt, Pt, Pt, Pt];
      if (!Number.isFinite(corners[2].x)) continue;
      const H = computeHomography(corners);
      for (const [u, v] of [[0.5, 0.5], [1 / 6, 1 / 6], [5 / 6, 1 / 6], [0.5, 5 / 6], [0.25, 0.75]]) {
        const want = project(M, u, v);
        const got = mapPoint(H, u, v);
        expect(got.x).toBeCloseTo(want.x, 6);
        expect(got.y).toBeCloseTo(want.y, 6);
      }
    }
  });

  it('射影変換はバイリニア補間と一致しない（正しく射影になっている）', () => {
    // 強い台形。バイリニアだと中心が (0.5,0.5) の平均に落ちるが射影では落ちない。
    const corners: [Pt, Pt, Pt, Pt] = [
      { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 200, y: 200 }, { x: 100, y: 200 },
    ];
    const H = computeHomography(corners);
    const center = mapPoint(H, 0.5, 0.5);
    const bilinear = {
      x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4,
      y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4,
    };
    expect(center.x).toBeCloseTo(150, 6); // 対称なので x は中央
    expect(Math.abs(center.y - bilinear.y)).toBeGreaterThan(5);
    // 射影では遠い側（狭い側）が圧縮されるので中心は y=100 より下（手前寄り）にくる
    expect(center.y).toBeGreaterThan(100);
  });

  it('アフィン（平行四辺形）の縮退ケースも扱える', () => {
    const corners: [Pt, Pt, Pt, Pt] = [
      { x: 10, y: 10 }, { x: 110, y: 30 }, { x: 130, y: 130 }, { x: 30, y: 110 },
    ];
    const H = computeHomography(corners);
    expect(H.g).toBe(0);
    expect(H.h).toBe(0);
    const p = mapPoint(H, 0.5, 0.5);
    expect(p.x).toBeCloseTo(70, 9);
    expect(p.y).toBeCloseTo(70, 9);
  });

  it('退化した四角形は例外', () => {
    expect(() =>
      computeHomography([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 }]),
    ).toThrow();
  });

  it('凸判定', () => {
    expect(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }])).toBe(true);
    // 自己交差（2番目と3番目を入れ替えた蝶形）
    expect(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }])).toBe(false);
  });
});
