import { describe, expect, it } from "vitest";
import {
  MOVE_NAMES,
  NUM_ORIENTATIONS,
  ORIENTATIONS,
  VIEW,
  applyMoves,
  cameraFaceOf,
  cubeFaceAt,
  invertMoves,
  isSolved,
  moveIndex,
  parseMoves,
  relativeMove,
  absoluteMove,
  rotateOrientation,
  solvedState,
  statesEqual,
  viewState,
  F,
  R,
  L,
  D,
} from "../src/cube/model";

const solved = solvedState();

function randomMoves(n: number, seed: number): number[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, () => Math.floor(rnd() * 18));
}

function colorCounts(state: Uint8Array): number[] {
  const c = new Array(6).fill(0);
  for (const v of state) c[v]++;
  return c;
}

describe("cube model (CLAUDE.md の必須テスト)", () => {
  it("U を4回で元に戻る", () => {
    expect(statesEqual(applyMoves(solved, "U U U U"), solved)).toBe(true);
  });

  it("各18手について、その手と逆手で元に戻る", () => {
    for (let m = 0; m < 18; m++) {
      const s = applyMoves(solved, [m, ...invertMoves([m])]);
      expect(statesEqual(s, solved), MOVE_NAMES[m]).toBe(true);
      expect(isSolved(applyMoves(solved, [m])), MOVE_NAMES[m]).toBe(false);
    }
  });

  it("(R U R' U') ×6 で元に戻る", () => {
    expect(statesEqual(applyMoves(solved, "R U R' U' ".repeat(6)), solved)).toBe(true);
    expect(statesEqual(applyMoves(solved, "R U R' U' ".repeat(3)), solved)).toBe(false);
  });

  it("T-perm ×2 で元に戻る", () => {
    const t = "R U R' U' R' F R2 U' R' U' R U R' F' ";
    expect(isSolved(applyMoves(solved, t))).toBe(false);
    expect(statesEqual(applyMoves(solved, t + t), solved)).toBe(true);
  });

  it("任意のスクランブルとその逆で元に戻り、各色は常に9枚", () => {
    for (let k = 0; k < 50; k++) {
      const moves = randomMoves(25, k + 1);
      const s = applyMoves(solved, moves);
      expect(colorCounts(s)).toEqual([9, 9, 9, 9, 9, 9]);
      expect(statesEqual(applyMoves(s, invertMoves(moves)), solved)).toBe(true);
    }
  });

  it("センターは動かない", () => {
    const s = applyMoves(solved, randomMoves(40, 7));
    for (let f = 0; f < 6; f++) expect(s[f * 9 + 4]).toBe(f);
  });

  it("R は F の右列を U へ送る", () => {
    const s = applyMoves(solved, "R");
    // U 面の右列（col 2）に F の色が来る
    expect([s[2], s[5], s[8]]).toEqual([F, F, F]);
    // F 面の右列には D の色
    expect([s[F * 9 + 2], s[F * 9 + 5], s[F * 9 + 8]]).toEqual([D, D, D]);
  });

  it("U は F の上段を L へ送る（時計回り）", () => {
    const s = applyMoves(solved, "U");
    expect([s[L * 9 + 0], s[L * 9 + 1], s[L * 9 + 2]]).toEqual([F, F, F]);
    expect([s[F * 9 + 0], s[F * 9 + 1], s[F * 9 + 2]]).toEqual([R, R, R]);
  });

  it("moveIndex / parseMoves", () => {
    expect(parseMoves("R U2 F'")).toEqual([moveIndex("R"), moveIndex("U2"), moveIndex("F'")]);
    expect(moveIndex("U2'")).toBe(moveIndex("U2"));
  });
});

describe("orientations", () => {
  it("24 通りの姿勢", () => {
    expect(NUM_ORIENTATIONS).toBe(24);
    expect(new Set(ORIENTATIONS.map((m) => m.join())).size).toBe(24);
  });

  it("y を4回で元に戻る / x y x' y' 系の整合性", () => {
    let o = 0;
    for (let i = 0; i < 4; i++) o = rotateOrientation(o, "y");
    expect(o).toBe(0);
    for (const r of ["x", "y", "z"] as const) {
      const a = rotateOrientation(rotateOrientation(0, r), r, 3);
      expect(a).toBe(0);
    }
    // x y x' y' は恒等ではない（非可換）
    let p = rotateOrientation(0, "x");
    p = rotateOrientation(p, "y");
    p = rotateOrientation(p, "x", 3);
    p = rotateOrientation(p, "y", 3);
    expect(p).not.toBe(0);
  });

  it("y の後はキューブの R 面がカメラ正面に来る… ではなく F 面が左へ", () => {
    // y = U 面を時計回り（上から見て）。F 面はカメラフレームの L へ、R 面が F へ
    const o = rotateOrientation(0, "y");
    expect(cubeFaceAt(o, F)).toBe(R);
    expect(cameraFaceOf(o, F)).toBe(L);
  });

  it("VIEW は各姿勢でカメラ面ごとに 9 facelet を重複なく割り当てる", () => {
    for (let o = 0; o < 24; o++) {
      const seen = new Set<number>();
      for (let i = 0; i < 54; i++) seen.add(VIEW[o * 54 + i]);
      expect(seen.size).toBe(54);
    }
  });

  it("姿勢を変えて見ても、その姿勢で回した手と整合する", () => {
    // キューブを持ち替えて（姿勢 o）、持ち方基準で R を回す = キューブ固定の absoluteMove(R, o) を回す
    for (let o = 0; o < 24; o++) {
      const s = applyMoves(solved, randomMoves(10, o + 100));
      for (let rel = 0; rel < 18; rel++) {
        const abs = absoluteMove(rel, o);
        expect(relativeMove(abs, o)).toBe(rel);
        const viewAfter = viewState(applyMoves(s, [abs]), o);
        // カメラフレームでの見え方が、カメラフレームの状態に rel を適用したものと一致
        const viewThenMove = applyMoves(viewState(s, o), [rel]);
        expect(Array.from(viewAfter)).toEqual(Array.from(viewThenMove));
      }
    }
  });
});

export { randomMoves };
