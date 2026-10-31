// 回している途中の層の組み立て: 面の外側の 1 列が本体（残りの 2 列）からずれていれば、その列を別の格子（VisibleFace.layer）にする。
// 形状認識（src/aruco/turn.ts）で層が分かれば、層が通る面の列を層の格子で置き、面から外れた層のマーカーもその列に入れる
import { beforeAll, describe, expect, it } from "vitest";
import { designOf } from "../src/aruco/design";
import { ARUCO_REFS } from "../src/aruco/palette";
import { VIEW, type Vec3, parseMoves } from "../src/cube/model";
import { processAruco } from "../src/vision/arucoFrame";
import type { CV } from "../src/vision/image";
import { applyMoveStickers, renderArucoCube, solvedStickers, stickerAt } from "./arucoCube";
import { loadTestOpenCv } from "./cv";

let cv: CV;
beforeAll(async () => {
  cv = await loadTestOpenCv();
}, 120000);

describe("回している途中の層", () => {
  let st = solvedStickers();
  for (const m of parseMoves("R U F' D2 L B")) st = applyMoveStickers(st, m);
  const at = stickerAt(st);
  const eye: Vec3 = [2.4, 2.4, 5.5];
  const frame = (move?: string, fraction = 0) =>
    processAruco(
      cv,
      renderArucoCube(cv, { width: 1280, height: 720, stickers: st, orient: 0, eye, noise: 2, seed: 3, scheme: "unique54", design: designOf("quad-half"), turn: move ? { move: parseMoves(move)[0], fraction } : undefined }),
      0,
      {},
      "unique54",
      false,
      { design: "quad-half" },
    );

  it("止まっているときは分けない", () => {
    for (const f of frame().faces) expect(f.layer).toBeUndefined();
  });

  it("U を回している途中: 正面の上の列が層。読めたマスは回す前のステッカー（誤りなし）", () => {
    for (const fraction of [0.1, 0.25, 0.35]) {
      const front = frame("U", fraction).faces.find((f) => f.slot === 2)!;
      expect(front.layer?.cells).toEqual([0, 1, 2]);
      for (let cell = 0; cell < 9; cell++) {
        if (!front.valid[cell]) continue;
        expect(front.labs[cell]).toEqual(ARUCO_REFS[Math.floor(at[VIEW[2 * 9 + cell]] / 9)]);
      }
      // 本体の 2 列はすべて読める（回っている列に格子が引っ張られない）
      for (const cell of [3, 4, 5, 6, 7, 8]) expect(front.valid[cell]).toBe(true);
    }
  });

  it("R を回している途中: 正面の右の列が層", () => {
    const front = frame("R", 0.25).faces.find((f) => f.slot === 2)!;
    expect(front.layer?.cells).toEqual([2, 5, 8]);
  });
});
