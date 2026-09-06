import { describe, it, expect } from 'vitest';
import { rgbToLab, labToRgb, deltaE, srgbToLinear } from '../src/vision/color';

describe('sRGB -> CIELab (D65)', () => {
  it('既知の値と一致する', () => {
    const cases: [number[], number[]][] = [
      [[255, 255, 255], [100, 0, 0]],
      [[0, 0, 0], [0, 0, 0]],
      [[255, 0, 0], [53.2408, 80.0925, 67.2032]],
      [[0, 255, 0], [87.7347, -86.1827, 83.1793]],
      [[0, 0, 255], [32.297, 79.1875, -107.8602]],
      [[255, 255, 0], [97.1393, -21.5537, 94.478]],
      [[128, 128, 128], [53.5851, 0, 0]],
    ];
    for (const [rgb, lab] of cases) {
      const got = rgbToLab(rgb[0], rgb[1], rgb[2]);
      expect(got[0]).toBeCloseTo(lab[0], 3);
      expect(got[1]).toBeCloseTo(lab[1], 3);
      expect(got[2]).toBeCloseTo(lab[2], 3);
    }
  });

  it('ガンマ展開の境界が連続', () => {
    expect(srgbToLinear(0.04045 * 255)).toBeCloseTo(0.0031308, 6);
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(255)).toBeCloseTo(1, 12);
  });

  it('往復変換で元の sRGB に戻る', () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const lab = rgbToLab(r, g, b);
          expect(labToRgb(lab[0], lab[1], lab[2])).toEqual([r, g, b]);
        }
      }
    }
  });

  it('照明強度が変わっても色相角がほぼ保たれる（Lab を使う理由）', () => {
    // 同じ色を暗くしたとき、a,b の絶対値は彩度とともに縮むが「色相角」は保たれる。
    // 最近傍分類が明るさ変動に耐えるのはこの性質による。
    const hue = (l: number[]) => (Math.atan2(l[2], l[1]) * 180) / Math.PI;
    for (const [r, g, b] of [[200, 60, 60], [60, 160, 90], [70, 90, 200]]) {
      const bright = rgbToLab(r, g, b);
      const dark = rgbToLab(Math.round(r * 0.6), Math.round(g * 0.6), Math.round(b * 0.6));
      expect(Math.abs(bright[0] - dark[0])).toBeGreaterThan(10); // L は大きく動く
      expect(Math.abs(hue(bright) - hue(dark))).toBeLessThan(3); // 色相角はほぼ不変
    }
  });
});

describe('deltaE', () => {
  it('同一色は 0、白黒は 100', () => {
    const w = rgbToLab(255, 255, 255);
    const k = rgbToLab(0, 0, 0);
    expect(deltaE(w, 0, w, 0)).toBe(0);
    expect(deltaE(w, 0, k, 0)).toBeCloseTo(100, 4); // D65 白色点の丸めぶんだけ 100 からずれる
  });

  it('オフセット付き配列で正しく読む', () => {
    const buf = new Float32Array([0, 0, 0, 3, 4, 0, 0, 0, 0]);
    expect(deltaE(buf, 0, buf, 3)).toBeCloseTo(5, 6);
  });
});
