// ID で完成・変化を見る（src/track/homeView.ts）: 合成のキューブ（4 個の配置のステッカー）を本体の認識に通した見え方で、
// 揃っていれば揃いと見る・PLL の途中や AUF（色は揃って見える面がある）は揃いにしない・持ち替えは変化にしない
import { beforeAll, describe, expect, it } from "vitest";
import { VIEW, applyMoves, invertMoves, parseMoves, solvedState } from "../src/cube/model";
import { changedFrom, solvedView } from "../src/track/homeView";
import type { CV } from "../src/vision/image";
import { loadTestOpenCv } from "./cv";
import { EYES, sightOf as render } from "./sightRender";

let cv: CV;
beforeAll(async () => {
  cv = await loadTestOpenCv();
}, 120000);

const sightOf = (moves: string | number[], orient: number, eye: (typeof EYES)[string]) => render(cv, moves, orient, eye);

const SOLVED_MIN = 10;
// 上の面（U）がカメラの上（スロット 0）に見える姿勢
const UP_ORIENTS = Array.from({ length: 24 }, (_, o) => o).filter((o) => VIEW[o * 54 + 4] === 4);
const stops = (v: ReturnType<typeof solvedView>) => v.ok && v.home >= SOLVED_MIN;

describe("solvedView", () => {
  it("揃ったキューブは、どの向きでも 2 面以上見えれば揃い", () => {
    for (const orient of [0, 5, 13, 22])
      for (const eye of ["three", "top", "side"]) {
        const v = solvedView(sightOf("", orient, EYES[eye]));
        expect(v.ok, `${orient} ${eye}`).toBe(true);
        expect(v.home, `${orient} ${eye}`).toBeGreaterThanOrEqual(SOLVED_MIN);
      }
  });

  it("正面だけでは数が足りない（9 枚まで）", () => {
    const v = solvedView(sightOf("", 0, EYES.front));
    expect(v.ok).toBe(true);
    expect(v.home).toBeLessThanOrEqual(9);
  });

  // PLL（白上・緑前の表記）と AUF。どれも上の面は 1 色、側面の上の段だけが入れ替わる
  const PLLS: Record<string, string> = {
    T: "R U R' U' R' F R2 U' R' U' R U R' F'",
    Ua: "R U' R U R U R U' R' U' R2",
    Ub: "R2 U R U R' U' R' U' R' U R'",
    H: "R2 U2 R U2 R2 U2 R2 U2 R U2 R2",
    Z: "R' U' R U' R U R U' R' U R U R2 U' R'",
    Aa: "R' F R' B2 R F' R' B2 R2",
    Jb: "R U R' F' R U R' U' R' F R2 U' R'",
    Y: "F R U' R' U' R U R' F' R U R' U' R' F R F'",
    AUF: "U",
    AUF2: "U2",
  };
  it("PLL の途中・AUF は揃いにしない（色は揃って見える面があっても ID の場所が違う）", () => {
    for (const [name, alg] of Object.entries(PLLS)) {
      // 揃った状態から PLL を逆に回す = PLL を回す前の状態（上の段だけが入れ替わっている）
      const moves = invertMoves(parseMoves(alg));
      expect(applyMoves(solvedState(), moves).some((c, i) => c !== solvedState()[i])).toBe(true);
      // 上の面がカメラの上を向く持ち方のうち 2 通り（側面だけが見える向きでも、上の段が見える）
      for (const orient of [UP_ORIENTS[0], UP_ORIENTS[2]])
        for (const eye of ["three", "top", "side"]) {
          const v = solvedView(sightOf(moves, orient, EYES[eye]));
          expect(stops(v), `${name} ${orient} ${eye} ${JSON.stringify(v)}`).toBe(false);
        }
    }
  }, 300000);
});

describe("changedFrom", () => {
  const scramble = "R U2 F' L D B2 R' U F2";
  const target = applyMoves(solvedState(), parseMoves(scramble));
  it("持ち替えただけ（全部の ID が一緒に動く）は変わっていない", () => {
    for (const orient of [0, 3, 9, 17])
      for (const eye of ["three", "top", "side"]) {
        const v = changedFrom(sightOf(scramble, orient, EYES[eye]), target);
        expect(v.read, `${orient} ${eye}`).toBeGreaterThanOrEqual(10);
        expect(v.mismatch, `${orient} ${eye}`).toBe(0);
      }
  });
  it("見えている層を 1 手回すと、その層の側面の 3 枚が変わる", () => {
    for (const m of ["R", "U'", "F2", "L"]) {
      const v = changedFrom(sightOf(`${scramble} ${m}`, 0, EYES.three), target);
      expect(v.worst, m).toBeGreaterThanOrEqual(2);
    }
  });
});
