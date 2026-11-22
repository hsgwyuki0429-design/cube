// ライブの 3D の見せ方（src/ui/liveShow.ts）: 層が動いたのを見た手だけ回し、見ていない手は回さずに塗り替える。3D の状態は同じ
import { describe, expect, it } from "vitest";
import { applyMoves, parseMoves, solvedState, statesEqual } from "../src/cube/model";
import { LiveShow, type ShowInput, seenMoves } from "../src/ui/liveShow";
import type { DecodedMove } from "../src/track/types";
import { SimScene } from "./liveShowSim";

const input = (moves: number[], moveSeen: boolean[], over: Partial<ShowInput> = {}): ShowInput => ({ epoch: 1, setupMoves: [], moves, moveSeen, ...over });

describe("LiveShow", () => {
  it("層の動きを見た手は回し、見ていない手は回さずに塗り替える", () => {
    const s = new SimScene(solvedState());
    const show = new LiveShow();
    const [R, U, F] = parseMoves("R U F");
    show.apply(s, input([], []));
    show.apply(s, input([R], [true]));
    s.advance(0);
    expect(s.log).toEqual([{ move: R, t: 0, instant: false }]);
    // 回している間に、見ていない手が足された: 回し終えてから塗り替える（順番は守る）
    show.apply(s, input([R, U], [true, false]));
    s.advance(50);
    expect(s.log.length).toBe(1);
    s.advance(400);
    expect(s.log[1]).toMatchObject({ move: U, instant: true });
    expect(statesEqual(s.state, applyMoves(solvedState(), [R, U]))).toBe(true);
    // 見た手はまた回す
    show.apply(s, input([R, U, F], [true, false, true]));
    s.advance(400);
    expect(s.log[2]).toMatchObject({ move: F, instant: false });
    s.advance(1000);
    expect(statesEqual(s.state, applyMoves(solvedState(), [R, U, F]))).toBe(true);
  });

  it("見ていない手だけなら、すぐその状態になる", () => {
    const s = new SimScene(solvedState());
    const show = new LiveShow();
    const moves = parseMoves("R' D'");
    show.apply(s, input([], []));
    show.apply(s, input(moves, [false, false]));
    s.advance(0);
    expect(s.log.every((x) => x.instant)).toBe(true);
    expect(statesEqual(s.state, applyMoves(solvedState(), moves))).toBe(true);
  });

  it("解釈が変わったら回さずに合わせる・手が溜まったら足された最後の手だけ、見ていれば回す", () => {
    const s = new SimScene(solvedState());
    const show = new LiveShow();
    const [R, U, F, D, B] = parseMoves("R U F D B");
    show.apply(s, input([], []));
    show.apply(s, input([R, U], [true, true]));
    s.advance(1000);
    // U が F に読み直された: 回さない
    show.apply(s, input([R, F], [true, true]));
    s.advance(1000);
    expect(s.log.length).toBe(2);
    expect(statesEqual(s.state, applyMoves(solvedState(), [R, F]))).toBe(true);
    // 3 手まとめて足された: 最後の 1 手だけ回す
    show.apply(s, input([R, F, U, D, B], [true, true, true, true, true]));
    s.advance(2000);
    expect(s.log.at(-1)).toMatchObject({ move: B, instant: false });
    expect(s.log.length).toBe(3);
    expect(statesEqual(s.state, applyMoves(solvedState(), [R, F, U, D, B]))).toBe(true);
    // 見ていない手なら回さない
    show.apply(s, input([R, F, U, D, B, R, U, F], [true, true, true, true, true, true, true, false]));
    s.advance(3000);
    expect(s.log.at(-1)).toMatchObject({ move: F, instant: true });
    expect(statesEqual(s.state, applyMoves(solvedState(), [R, F, U, D, B, R, U, F]))).toBe(true);
  });

  it("推定した手・層の動きを見ていない手は seenMoves で false", () => {
    const m = (inferred: boolean): DecodedMove => ({ move: 0, t: 0, orient: 0, inferred }) as DecodedMove;
    const tm = (moved: boolean) => ({ start: 0, end: 0, exact: moved, endExact: moved, moved });
    expect(seenMoves([m(false), m(true), m(false), m(false)], [tm(true), tm(true), tm(false), null])).toEqual([true, false, false, false]);
    expect(seenMoves([m(false)], undefined)).toEqual([false]);
  });
});
