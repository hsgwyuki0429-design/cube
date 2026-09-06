import { describe, it, expect } from 'vitest';
import { rgbToLab, labToRgb, deltaE, srgbToLinear } from '../src/vision/color';
import { makeRng } from '../src/core/cube';

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

import {
  classifyLab, classifyCells, refMinDistance, adaptRef, FaceAccumulator,
  MIN_SEPARATION_WARN,
} from '../src/vision/color';

/** 標準配色に近い6色を Lab で用意する。 */
function standardRef(): Float32Array {
  const rgb: [number, number, number][] = [
    [255, 255, 255], // U 白
    [200, 30, 30],   // R 赤
    [30, 160, 60],   // F 緑
    [250, 220, 40],  // D 黄
    [255, 130, 20],  // L 橙
    [30, 70, 190],   // B 青
  ];
  const out = new Float32Array(18);
  rgb.forEach((c, i) => {
    const l = rgbToLab(c[0], c[1], c[2]);
    out.set(l, i * 3);
  });
  return out;
}

/** パステル配色（判別が苦しい想定） */
function pastelRef(): Float32Array {
  const rgb: [number, number, number][] = [
    [245, 245, 240], [235, 170, 175], [175, 220, 185],
    [245, 235, 175], [245, 200, 165], [175, 195, 230],
  ];
  const out = new Float32Array(18);
  rgb.forEach((c, i) => out.set(rgbToLab(c[0], c[1], c[2]), i * 3));
  return out;
}

describe('色分類', () => {
  it('代表ベクトルそのものは距離0・信頼度1で自分に分類される', () => {
    const ref = standardRef();
    for (let f = 0; f < 6; f++) {
      const c = classifyLab(ref, f * 3, ref);
      expect(c.label).toBe(f);
      expect(c.d1).toBe(0);
      expect(c.conf).toBe(1);
    }
  });

  it('ノイズを乗せても正しく分類され、信頼度は下がる', () => {
    const ref = standardRef();
    const rng = makeRng(11);
    let correct = 0;
    let total = 0;
    let confSum = 0;
    for (let f = 0; f < 6; f++) {
      for (let k = 0; k < 200; k++) {
        const probe = new Float32Array([
          ref[f * 3] + (rng() - 0.5) * 12,
          ref[f * 3 + 1] + (rng() - 0.5) * 12,
          ref[f * 3 + 2] + (rng() - 0.5) * 12,
        ]);
        const c = classifyLab(probe, 0, ref);
        if (c.label === f) correct++;
        confSum += c.conf;
        total++;
      }
    }
    expect(correct / total).toBeGreaterThan(0.99);
    expect(confSum / total).toBeLessThan(1);
    expect(confSum / total).toBeGreaterThan(0.5);
  });

  it('2色の中間点では信頼度がほぼ0になる（正直に出す）', () => {
    const ref = standardRef();
    const mid = new Float32Array([
      (ref[0] + ref[3]) / 2, (ref[1] + ref[4]) / 2, (ref[2] + ref[5]) / 2,
    ]);
    const c = classifyLab(mid, 0, ref);
    expect(c.conf).toBeLessThan(0.02);
  });

  it('9セルまとめての分類', () => {
    const ref = standardRef();
    const lab = new Float32Array(27);
    for (let i = 0; i < 9; i++) lab.set([ref[6], ref[7], ref[8]], i * 3); // 全部 F 色
    const labels = new Int8Array(9);
    const conf = new Float32Array(9);
    classifyCells(lab, ref, labels, conf);
    expect(Array.from(labels)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(Array.from(conf).every((c) => c === 1)).toBe(true);
  });
});

describe('配色の判別可能性', () => {
  it('標準配色は十分に離れている', () => {
    const { d } = refMinDistance(standardRef());
    expect(d).toBeGreaterThan(MIN_SEPARATION_WARN);
  });

  it('パステル配色は最小距離が小さく警告対象になる', () => {
    const { d, a, b } = refMinDistance(pastelRef());
    expect(d).toBeLessThan(MIN_SEPARATION_WARN);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });

  it('最小距離は対称で、同一ベクトルが2つあれば0', () => {
    const ref = standardRef();
    ref.set([ref[0], ref[1], ref[2]], 15); // B を U と同じにする
    const { d, a, b } = refMinDistance(ref);
    expect(d).toBe(0);
    expect([a, b]).toEqual([0, 5]);
  });
});

describe('オンライン適応 (EMA)', () => {
  it('高信頼セルだけを使って代表ベクトルが観測に寄っていく', () => {
    const ref = standardRef();
    const target = new Float32Array(ref); // 参照用のコピー
    const lab = new Float32Array(27);
    // F 色が少し明るくなった状況（照明が明るくなった）
    for (let i = 0; i < 9; i++) lab.set([ref[6] + 6, ref[7], ref[8]], i * 3);
    const labels = new Int8Array(9).fill(2);
    const conf = new Float32Array(9).fill(0.9);
    for (let k = 0; k < 50; k++) adaptRef(ref, lab, labels, conf, 0.5, 0.02);
    expect(ref[6]).toBeGreaterThan(target[6] + 3);
    expect(ref[6]).toBeLessThan(target[6] + 6.1);
    // 他の色は動かない
    expect(ref[0]).toBe(target[0]);
  });

  it('低信頼セルは更新に使われない', () => {
    const ref = standardRef();
    const before = new Float32Array(ref);
    const lab = new Float32Array(27);
    for (let i = 0; i < 9; i++) lab.set([50, 50, 50], i * 3);
    const labels = new Int8Array(9).fill(2);
    const conf = new Float32Array(9).fill(0.1);
    const used = adaptRef(ref, lab, labels, conf, 0.5, 0.1);
    expect(used).toBe(0);
    expect(Array.from(ref)).toEqual(Array.from(before));
  });
});

describe('キャリブレーション蓄積', () => {
  it('9セル×複数フレームを平均し、ばらつきを出す', () => {
    const acc = new FaceAccumulator();
    const rng = makeRng(3);
    const base = [60, -20, 30];
    for (let frame = 0; frame < 10; frame++) {
      const lab = new Float32Array(27);
      for (let i = 0; i < 9; i++) {
        lab.set([base[0] + (rng() - 0.5) * 4, base[1] + (rng() - 0.5) * 4, base[2] + (rng() - 0.5) * 4], i * 3);
      }
      acc.add(lab);
    }
    expect(acc.count).toBe(90);
    const { lab, spread } = acc.result();
    expect(lab[0]).toBeCloseTo(base[0], 0);
    expect(lab[1]).toBeCloseTo(base[1], 0);
    expect(lab[2]).toBeCloseTo(base[2], 0);
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeLessThan(4);
  });
});
