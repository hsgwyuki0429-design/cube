// ソルブ中のライブの状態の推定（src/track/liveState.ts）が、一度外れた後に読みで戻ること: 物理的にありえる状態の判定と、それで決まる
// ピース（deduce）・読みと食い違い続けるピースの置き直し（fixRun）
import { describe, expect, it } from "vitest";
import { applyMoves, parseMoves, solvedState, statesEqual } from "../src/cube/model";
import { isValidState } from "../src/cube/pattern";
import { NUM_PIECES, IS_CORNER } from "../src/track/pieces/model";
import { LiveState, type LiveFrame, hypOf, physical } from "../src/track/liveState";

const posOf = (state: Uint8Array) => Array.from(hypOf(state), (m) => 31 - Math.clz32(m));

describe("物理的にありえる状態（physical）", () => {
  it("回して作った状態はありえる・コーナー 1 つのねじれ・エッジ 1 つの反転・2 つの入れ替えはありえない（isValidState と同じ）", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 200; n++) {
      const moves = Array.from({ length: 1 + Math.floor(rnd() * 25) }, () => Math.floor(rnd() * 18));
      const st = applyMoves(solvedState(), moves);
      const pos = posOf(st);
      expect(physical(pos)).toBe(true);
      expect(isValidState(st)).toBe(true);
    }
    const st = applyMoves(solvedState(), parseMoves("R U R' F2 D L'"));
    const pos = posOf(st);
    // 同じ種類の 2 つのピースの位置を入れ替える（場所だけ）: 偶奇が変わる
    const corners = Array.from({ length: NUM_PIECES }, (_, p) => p).filter((p) => IS_CORNER[p]);
    const swapped = pos.slice();
    [swapped[corners[0]], swapped[corners[1]]] = [swapped[corners[1]], swapped[corners[0]]];
    expect(physical(swapped)).toBe(false);
  });
});

// 置き方の決まった面の読み（ピースとその位置）だけの 1 フレーム
function frameOf(t: number, truth: Uint8Array, pieces: number[]): LiveFrame {
  const pos = posOf(truth);
  return {
    t,
    n: pieces.length,
    piece: Int8Array.from(pieces),
    cls: Uint8Array.from(pieces, (p) => (IS_CORNER[p] ? 0 : 1)),
    kind: new Uint8Array(pieces.length),
    ys: Int16Array.from(pieces.flatMap((p) => [pos[p], pos[p], pos[p], pos[p]])),
    groups: [{ mode: 0, face: 0, cr: 0, prior: [0, 0, 0, 0], from: 0, to: pieces.length, faces: [], placed: [null, null, null, null] }],
    centers: [],
    orient: 0,
    pieces: pieces.length,
  };
}

describe("一度外れた推定が読みで戻る", () => {
  // 推定は A-perm（コーナー 3 つの入れ替え。エッジは同じ）の状態だと思っているが、本当は揃っている。読めるのはエッジと、コーナーは 1 つずつ
  const believed = applyMoves(solvedState(), parseMoves("R' F R' B2 R F' R' B2 R2"));
  const truth = solvedState();
  const wrong = posOf(believed).map((x, p) => (x !== posOf(truth)[p] ? p : -1)).filter((p) => p >= 0);
  const edges = Array.from({ length: NUM_PIECES }, (_, p) => p).filter((p) => !IS_CORNER[p]).slice(0, 6);
  const run = (fixRun: number) => {
    const live = new LiveState(believed, 0, 0, [], null, { fixRun });
    let t = 0;
    for (const p of wrong.slice(0, 2)) for (let k = 0; k < 4; k++) live.push(frameOf((t += 33), truth, [...edges, p]));
    return live;
  };

  it("食い違うのは 3 つのコーナー（読むのは 1 つずつ）", () => {
    expect(wrong.length).toBe(3);
    expect(wrong.every((p) => IS_CORNER[p])).toBe(true);
  });

  it("置き直さないと、1 つのピースの食い違いが続いても戻らない（lostBits に届かない）", () => {
    const live = run(0);
    expect(statesEqual(live.display(), truth)).toBe(false);
  });

  it("同じ位置に続けて読めたピースを置き直し、残りのコーナーは物理的にありえる置き方で決まる", () => {
    const live = run(3);
    expect(live.stats.relocated).toBe(2);
    expect(live.known()).toBe(true);
    expect(statesEqual(live.stateOf(live.best()), truth)).toBe(true);
    // 手順はつながらない所（base）があり、そこからは見えた状態
    expect(live.best().base).not.toBeNull();
  });
});
