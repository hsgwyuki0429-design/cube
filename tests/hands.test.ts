// 手の 21 点から作る「手が覆う範囲」: 指の縁まで隠し、指の間は隠さない
import { describe, expect, it } from "vitest";
import type { Pt } from "../src/vision/homography";
import { handMasks } from "../src/vision/handsClient";
import { pointInPolygon } from "../src/vision/lattice";

// 手首 (0.5, 0.9)、指は上向きにまっすぐ。手のひらの長さ（手首〜中指の付け根）0.3
function straightHand(): Pt[] {
  const p: Pt[] = [[0.5, 0.9]];
  // 親指 1-4（左へ斜め）
  for (let k = 1; k <= 4; k++) p.push([0.5 - 0.05 * k, 0.85 - 0.04 * k]);
  // 人差し指〜小指（付け根の y = 0.6、x の間隔 0.06）
  for (const x of [0.41, 0.47, 0.53, 0.59]) for (let k = 0; k < 4; k++) p.push([x, 0.6 - 0.07 * k]);
  return p;
}

describe("handMasks", () => {
  const masks = handMasks(straightHand(), 1);
  const covered = (pt: Pt) => masks.some((m) => pointInPolygon(pt, m));
  it("covers the finger edges, not only the joint line", () => {
    // 人差し指の骨から指の半径（0.3 × 0.16 = 0.048）より少し内側
    expect(covered([0.41 + 0.04, 0.5])).toBe(true);
    expect(covered([0.41 - 0.04, 0.5])).toBe(true);
    // 指先の少し先
    expect(covered([0.41, 0.6 - 0.21 - 0.03])).toBe(true);
  });
  it("does not cover what is clearly outside the hand", () => {
    expect(covered([0.41 - 0.12, 0.45])).toBe(false);
    expect(covered([0.5, 0.2])).toBe(false);
  });
});
