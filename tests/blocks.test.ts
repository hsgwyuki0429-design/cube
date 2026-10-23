import { describe, expect, it } from "vitest";
import { expandBlocks } from "../src/vision/blocks";
import type { Mat3 } from "../src/vision/homography";
import type { Quad } from "../src/vision/lattice";

// 格子座標 (u, v) → 画像: 1 ピッチ = 50px、原点 (100, 100)
const H: Mat3 = [50, 0, 100, 0, 50, 100, 0, 0, 1];
const quad = (u0: number, v0: number, u1: number, v1: number): Quad => {
  const corners: [number, number][] = [
    [100 + u0 * 50, 100 + v0 * 50],
    [100 + u1 * 50, 100 + v0 * 50],
    [100 + u1 * 50, 100 + v1 * 50],
    [100 + u0 * 50, 100 + v1 * 50],
  ];
  return { corners, center: [100 + ((u0 + u1) / 2) * 50, 100 + ((v0 + v1) / 2) * 50], area: (u1 - u0) * (v1 - v0) * 2500 };
};

describe("expandBlocks（ステッカーレスの同色ブロックの分割）", () => {
  it("2x3 のブロックを 6 個の仮想ステッカーに分ける", () => {
    const out = expandBlocks([quad(0, 0, 2, 3)], [H]);
    expect(out.length).toBe(6);
    const centers = out.map((q) => q.center.map((v) => Math.round(v)).join(",")).sort();
    expect(centers).toContain("125,125");
    expect(centers).toContain("175,225");
  });

  it("1枚のステッカー・面の外のもの・直前の面がないときはそのまま", () => {
    expect(expandBlocks([quad(0.05, 0.05, 0.95, 0.95)], [H]).length).toBe(1);
    expect(expandBlocks([quad(5, 5, 7, 7)], [H]).length).toBe(1);
    expect(expandBlocks([quad(0, 0, 3, 3)], []).length).toBe(1);
  });

  it("中に他の四角形を含む大きな四角形（面の外形）は分割しない", () => {
    const out = expandBlocks([quad(0, 0, 3, 3), quad(0.1, 0.1, 0.9, 0.9), quad(1.1, 1.1, 1.9, 1.9)], [H]);
    expect(out.length).toBe(3);
  });
});
