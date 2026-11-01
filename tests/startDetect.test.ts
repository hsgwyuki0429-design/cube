// タイマーの開始の判定（src/app/startDetect.ts）: 誤読を 2 手で説明した仮説ですぐに始めない。層が動いたのを見た確定した手、
// またはスクランブルの状態から外れたまま続いたら始める
import { describe, expect, it } from "vitest";
import { StartDetector } from "../src/app/startDetect";
import { applyMoves, parseMoves, solvedState } from "../src/cube/model";

const target = applyMoves(solvedState(), parseMoves("R U F"));
// 手の時刻は、エンジンが最初に読んだときのまま（movesAt: 1 手目を読んだ観測の時刻）
function update(t: number, moves: string, confirmed: number, timing?: { start: number; moved: boolean }, movesAt = t) {
  const ms = moves ? parseMoves(moves) : [];
  return {
    state: Array.from(applyMoves(target, ms)),
    moves: ms.map((m, i) => ({ move: m, t0: movesAt - 40 + i, t: movesAt - 20 + i, orient: 0 })),
    confirmed,
    timings: ms.map((_, i) => (i === 0 && timing ? { start: timing.start, end: t, exact: true, endExact: true, moved: timing.moved } : null)),
    observations: 5,
    observation: { t, faces: [] },
  };
}

describe("StartDetector", () => {
  it("does not start on a misread explained by two moves that comes back", () => {
    const d = new StartDetector();
    expect(d.push(update(1000, "", 0), target, 0)).toBeNull();
    // 誤読: 2 手（確定）で説明されたが、層は動いていない
    expect(d.push(update(1100, "R U", 2, { start: 1060, moved: false }), target, 0)).toBeNull();
    // 次の観測で読みが戻る: 逆の 2 手を足して元の状態
    expect(d.push(update(1200, "R U U' R'", 4), target, 0)).toBeNull();
    expect(d.push(update(1700, "R U U' R'", 4), target, 0)).toBeNull();
  });

  it("starts at once on a confirmed move whose layer was seen moving", () => {
    const d = new StartDetector();
    expect(d.push(update(2000, "D", 1, { start: 1880, moved: true }), target, 0)).toBe(1880);
  });

  it("does not start on an unconfirmed move until it holds", () => {
    const d = new StartDetector();
    expect(d.push(update(3000, "F", 0, { start: 2950, moved: true }), target, 0)).toBeNull();
    expect(d.push(update(3200, "F", 0, undefined, 3000), target, 0)).toBeNull();
    // 外れたまま 350ms・2 観測: 外れ始めた所（最初の手を読んだ観測の手前）まで遡って始める
    expect(d.push(update(3400, "F", 0, undefined, 3000), target, 0)).toBe(2960);
  });

  it("starts when the view keeps disagreeing even without a readable first move", () => {
    const d = new StartDetector();
    expect(d.push(update(4000, "B", 0), target, 0)).toBeNull();
    expect(d.push(update(4400, "B L", 0, undefined, 4000), target, 0)).toBe(3960);
  });

  it("does not reach far back when the previous reading was last seen long ago (fingers covered the cube)", () => {
    const d = new StartDetector();
    // 手の t0（前の読みが最後に見えた時刻）が 5 秒前。層の動き出しは分からない
    expect(d.push(update(6000, "F", 0, undefined, 1000), target, 0)).toBeNull();
    expect(d.push(update(6400, "F R", 0, undefined, 1000), target, 0)).toBe(5700);
  });
});
