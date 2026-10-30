// 円環図（極投影の同心円。src/ui/ring.ts）: 54 マスが重ならずに並び、U・D の手がリングの回転になること
import { describe, expect, it } from "vitest";
import { MOVE_DEST, parseMoves } from "../src/cube/model";
import { RING_CELLS, cellPath, moveArrows } from "../src/ui/ring";

const deg = (a: number) => Math.round((a * 180) / Math.PI) % 360;

describe("円環図", () => {
  it("内側から 1・8・12・12・12・8・1 マスで、同じリングのマスは重ならない", () => {
    const count = [0, 0, 0, 0, 0, 0, 0];
    for (const c of RING_CELLS) count[c.ring]++;
    expect(count).toEqual([1, 8, 12, 12, 12, 8, 1]);
    for (let r = 1; r <= 5; r++) {
      const angles = RING_CELLS.filter((c) => c.ring === r).map((c) => deg(c.angle));
      expect(new Set(angles).size).toBe(angles.length);
    }
    // 正面（F）の真ん中の列は下（角度 0）、R は右（90°）
    expect(deg(RING_CELLS[19].angle)).toBe(0); // F の上段の真ん中
    expect(RING_CELLS[19].ring).toBe(2);
    expect(deg(RING_CELLS[7].angle)).toBe(0); // U の手前の辺（UF）
    expect(deg(RING_CELLS[13].angle)).toBe(90); // R のセンター
    expect(RING_CELLS[13].ring).toBe(3);
  });

  it("U は U の周りと上段を 90° 回す（上から見て時計回り = 角度が減る）。D は下段と D の周りを逆向きに", () => {
    for (const [name, rings, turn] of [
      ["U", [1, 2], -90],
      ["D", [4, 5], 90],
    ] as const) {
      const m = parseMoves(name)[0];
      for (const { from, to } of moveArrows(m)) {
        const a = RING_CELLS[from];
        const b = RING_CELLS[to];
        expect(rings).toContain(a.ring);
        expect(b.ring).toBe(a.ring);
        expect((((deg(b.angle) - deg(a.angle) - turn) % 360) + 360) % 360).toBe(0);
      }
    }
  });

  it("R は側面の 3 段と U・D のリングをまたぐ", () => {
    const arrows = moveArrows(parseMoves("R")[0]);
    expect(arrows.length).toBe(20);
    expect(arrows.every(({ from, to }) => MOVE_DEST[parseMoves("R")[0]][from] === to)).toBe(true);
    expect(new Set(arrows.map((a) => RING_CELLS[a.from].ring))).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("外形の path を作れる（センターは円・円環）", () => {
    expect(cellPath(RING_CELLS[4], 100)).toMatch(/^M .* A .* Z$/);
    expect(cellPath(RING_CELLS[31], 100).split("M").length).toBe(3); // D センター: 外と内の 2 つの円
    expect(cellPath(RING_CELLS[0], 100)).toContain("L");
  });
});
