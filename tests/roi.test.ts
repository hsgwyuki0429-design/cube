import { describe, it, expect } from 'vitest';
import {
  orientCell,
  cellSamplePoints,
  cellCenters,
  validateRoi,
  defaultRois,
  DEFAULT_SAMPLES_PER_AXIS,
  type RoiConfig,
} from '../src/vision/roi';

const axisAligned = (): RoiConfig => ({
  id: 't',
  face: 2,
  corners: [{ x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0.3, y: 0.3 }, { x: 0, y: 0.3 }],
  rotate: 0,
  mirror: false,
  enabled: true,
});

describe('ROI セル幾何', () => {
  it('回転なし・軸並行 ROI ではセル中心が 3x3 の格子中心に一致する', () => {
    const centers = cellCenters(axisAligned());
    for (let i = 0; i < 9; i++) {
      const row = Math.floor(i / 3);
      const col = i % 3;
      expect(centers[i].x).toBeCloseTo(((col + 0.5) / 3) * 0.3, 9);
      expect(centers[i].y).toBeCloseTo(((row + 0.5) / 3) * 0.3, 9);
    }
  });

  it('サンプリング点は中央50%領域に収まり、セル境界を跨がない', () => {
    const roi = axisAligned();
    const k = DEFAULT_SAMPLES_PER_AXIS;
    const pts = cellSamplePoints(roi, k);
    expect(pts.length).toBe(9 * k * k * 2);
    for (let i = 0; i < 9; i++) {
      const row = Math.floor(i / 3);
      const col = i % 3;
      // セル境界（正規化 ROI 内 0..1 換算）
      const u0 = col / 3, u1 = (col + 1) / 3, v0 = row / 3, v1 = (row + 1) / 3;
      const margin = (u1 - u0) * 0.25;
      for (let s = 0; s < k * k; s++) {
        const base = (i * k * k + s) * 2;
        const u = pts[base] / 0.3;
        const v = pts[base + 1] / 0.3;
        expect(u).toBeGreaterThanOrEqual(u0 + margin - 1e-9);
        expect(u).toBeLessThanOrEqual(u1 - margin + 1e-9);
        expect(v).toBeGreaterThanOrEqual(v0 + margin - 1e-9);
        expect(v).toBeLessThanOrEqual(v1 - margin + 1e-9);
      }
    }
  });

  it('rotate は 4 回で元に戻り、各回で置換になっている（重複なし）', () => {
    for (let rot = 0; rot < 4; rot++) {
      const seen = new Set<string>();
      for (let i = 0; i < 9; i++) {
        const [r, c] = orientCell(Math.floor(i / 3), i % 3, rot, false);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(2);
        seen.add(`${r},${c}`);
      }
      expect(seen.size).toBe(9);
    }
    for (let i = 0; i < 9; i++) {
      const row = Math.floor(i / 3), col = i % 3;
      let [r, c] = [row, col];
      for (let k = 0; k < 4; k++) [r, c] = orientCell(r, c, 1, false);
      expect([r, c]).toEqual([row, col]);
    }
  });

  it('rotate=1 は facelet (0,0) を ROI グリッドの (0,2) に写す', () => {
    expect(orientCell(0, 0, 1, false)).toEqual([0, 2]);
    expect(orientCell(0, 2, 1, false)).toEqual([2, 2]);
  });

  it('mirror は列を反転する', () => {
    expect(orientCell(0, 0, 0, true)).toEqual([0, 2]);
    expect(orientCell(1, 1, 0, true)).toEqual([1, 1]);
  });

  it('斜めから見た ROI でもセル中心は9個すべて四角形の内側', () => {
    const roi: RoiConfig = {
      ...axisAligned(),
      corners: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.16 }, { x: 0.44, y: 0.5 }, { x: 0.14, y: 0.42 }],
    };
    for (const p of cellCenters(roi)) {
      expect(p.x).toBeGreaterThan(0.09);
      expect(p.x).toBeLessThan(0.51);
      expect(p.y).toBeGreaterThan(0.09);
      expect(p.y).toBeLessThan(0.51);
    }
  });

  it('validateRoi はねじれ・極小 ROI を弾く', () => {
    expect(validateRoi(axisAligned())).toBeNull();
    const twisted: RoiConfig = {
      ...axisAligned(),
      corners: [{ x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0, y: 0.3 }, { x: 0.3, y: 0.3 }],
    };
    expect(validateRoi(twisted)).not.toBeNull();
    const tiny: RoiConfig = {
      ...axisAligned(),
      corners: [{ x: 0, y: 0 }, { x: 0.01, y: 0 }, { x: 0.01, y: 0.01 }, { x: 0, y: 0.01 }],
    };
    expect(validateRoi(tiny)).not.toBeNull();
  });

  it('既定 ROI は 2 枚で、それぞれ別の面に割り当てられている', () => {
    const rois = defaultRois();
    expect(rois.length).toBe(2);
    expect(rois[0].face).not.toBe(rois[1].face);
    for (const r of rois) expect(validateRoi(r)).toBeNull();
  });
});
