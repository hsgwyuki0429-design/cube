// 表示の持ち方（src/cube/hold.ts）: cubing.js の持ち替えの後に持ち方での手を回すと、キューブ固定の手を回してから持ち替えたのと同じ
import { Alg } from "cubing/alg";
import { describe, expect, it } from "vitest";
import { holdWithDown } from "../src/cube/hold";
import { MOVE_NAMES, NUM_MOVES, cubeFaceAt, relativeMove } from "../src/cube/model";
import { loadKPuzzle } from "../src/cube/pattern";

describe("表示の持ち方", () => {
  it("クロスの面が下、持ち替えと手の読み替えが cubing.js と合う", async () => {
    const kpuzzle = await loadKPuzzle();
    for (let face = 0; face < 6; face++) {
      const h = holdWithDown(face);
      expect(cubeFaceAt(h.o, 3)).toBe(face);
      for (let m = 0; m < NUM_MOVES; m++) {
        const a = kpuzzle.defaultPattern().applyAlg(new Alg(`${h.rotation} ${MOVE_NAMES[relativeMove(m, h.o)]}`));
        const b = kpuzzle.defaultPattern().applyAlg(new Alg(`${MOVE_NAMES[m]} ${h.rotation}`));
        expect(a.isIdentical(b), `${face} ${h.rotation} ${MOVE_NAMES[m]}`).toBe(true);
      }
    }
    expect(holdWithDown(3).rotation).toBe("");
    expect(holdWithDown(0).rotation).toBe("z2");
  });
});
