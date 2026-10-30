// 円環図（src/ui/ring.ts）: 層ごとに側面の 12 枚が 1 本の曲線（球面上の円を写したもの）の上に並び、各ステッカーは 2 本の交わるところにある。
// 面を回すと、その層の曲線に沿ってステッカーが 3 つずつ進む
import { describe, expect, it } from "vitest";
import { parseMoves } from "../src/cube/model";
import { RING_CIRCLES, RING_POINTS, moveArrows, ringAngle, ringArc, ringDirection, turnCircle } from "../src/ui/ring";

const near = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

describe("円環図", () => {
  it("9 本の層の曲線に 12 枚ずつ。センター以外は 2 本、センターは 2 本（間の層）の上にあり、点は曲線の上にある", () => {
    expect(RING_CIRCLES.length).toBe(9);
    for (const rc of RING_CIRCLES) {
      expect(rc.facelets.length).toBe(12);
      for (const f of rc.facelets) {
        const a = ringAngle(rc, f);
        expect(near(ringArc(rc, a, a + 0.001, 1)[0], RING_POINTS[f])).toBe(true);
      }
    }
    for (let f = 0; f < 54; f++) expect(RING_CIRCLES.filter((rc) => rc.facelets.includes(f)).length).toBe(2);
    // 点は重ならず、半径 1 以内
    for (let i = 0; i < 54; i++) {
      expect(Math.hypot(...RING_POINTS[i])).toBeLessThanOrEqual(1 + 1e-9);
      for (let j = i + 1; j < 54; j++) expect(Math.hypot(RING_POINTS[i][0] - RING_POINTS[j][0], RING_POINTS[i][1] - RING_POINTS[j][1])).toBeGreaterThan(0.02);
    }
  });

  it("U・R・F の角から見た向き: U が上、F が左下、R が右下", () => {
    const [u, r, f] = [4, 13, 22].map((i) => RING_POINTS[i]);
    expect(u[1]).toBeLessThan(r[1]);
    expect(u[1]).toBeLessThan(f[1]);
    expect(f[0]).toBeLessThan(r[0]);
  });

  for (const name of ["U", "R'", "F", "D2", "L", "B'"]) {
    it(`${name}: 側面のステッカーは回した層の曲線の上を、決めた向きに 90°（半回転は 180°）進む`, () => {
      const m = parseMoves(name)[0];
      const rc = turnCircle(Math.floor(m / 3));
      const side = moveArrows(m).filter(({ from, to }) => Math.floor(from / 9) !== Math.floor(to / 9));
      expect(side.length).toBe(12);
      const quarter = name.endsWith("2") ? 2 : 1;
      for (const { from, to } of side) {
        expect(rc.facelets).toContain(from);
        expect(rc.facelets).toContain(to);
        const d = (((ringAngle(rc, to) - ringAngle(rc, from)) * ringDirection(m)) / (Math.PI / 2) + 8) % 4;
        expect(Math.abs(d - quarter)).toBeLessThan(1e-6);
      }
    });
  }
});
