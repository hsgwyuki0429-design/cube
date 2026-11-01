// スクランブルの案内（src/app/scrambleGuide.ts）: 案内は作り直さず、進み具合・半回転の途中・ずれたときの戻す手を求める
import { describe, expect, it } from "vitest";
import { ScrambleGuide, undoMoves } from "../src/app/scrambleGuide";
import { MOVE_NAMES, applyMoves, parseMoves, solvedState } from "../src/cube/model";

const names = (ms: number[] | null) => (ms ? ms.map((m) => MOVE_NAMES[m]).join(" ") : null);

describe("スクランブルの案内", () => {
  const scramble = parseMoves("R U2 F' L D2 B R'");
  const g = new ScrambleGuide(solvedState(), scramble);

  it("案内どおりに回すと、済んだ手数が進む", () => {
    for (let k = 0; k <= scramble.length; k++) {
      const pos = g.locate(applyMoves(solvedState(), scramble.slice(0, k)), Math.max(0, k - 1));
      expect(pos).toEqual({ done: k, half: false, fix: [], fixTo: k });
    }
  });

  it("U2 を U だけ（U' だけ）回したのは途中で、ずれではない", () => {
    for (const q of ["U", "U'"]) {
      const pos = g.locate(applyMoves(solvedState(), `R ${q}`), 1);
      expect(pos.half).toBe(true);
      expect(pos.done).toBe(1);
      expect(pos.fix).toEqual([]);
    }
  });

  it("違う手を回したら、元の案内に戻す手を出す（同じ長さなら先へ進む方）", () => {
    // R の次に U2 の代わりに F: F' で戻る
    expect(names(g.locate(applyMoves(solvedState(), "R F"), 1).fix)).toBe("F'");
    // R U2 の次に F' の代わりに F: F2 で F' の後へ進む
    const pos = g.locate(applyMoves(solvedState(), "R U2 F"), 2);
    expect(names(pos.fix)).toBe("F2");
    expect(pos.fixTo).toBe(3);
    expect(pos.done).toBe(2);
  });

  it("近くに戻り道がなければ null（読めた手を逆にたどる）", () => {
    const far = applyMoves(solvedState(), "R D B2 L' F U'");
    expect(g.locate(far, 1).fix).toBeNull();
    expect(names(undoMoves(parseMoves("D B2 L' F U'")))).toBe("U F' L B2 D'");
    expect(names(undoMoves(parseMoves("U U")))).toBe("U2");
    expect(names(undoMoves(parseMoves("U U'")))).toBe("");
  });
});
