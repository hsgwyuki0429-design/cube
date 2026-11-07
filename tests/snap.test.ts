// ライブの作り変え（src/track/snap.ts・TrackerEngine の snapToView）: 手順を追えない見え方の変化（見えない間に何手も回した・
// 読み違えて見失った）でも、見えている色の組み合わせに合う状態にその場で作り変え、そこから追跡を続ける
import { describe, expect, it } from "vitest";
import { F, R, U, VIEW, applyMove, applyMoves, isSolved, parseMoves, solvedState, statesEqual } from "../src/cube/model";
import { isValidState } from "../src/cube/pattern";
import { ARUCO_REFS } from "../src/aruco/palette";
import { TrackerEngine } from "../src/track/engine";
import { snapToObservation } from "../src/track/snap";
import { stickerIds } from "../src/cube/stickers";
import { observe, rng } from "./sim";

const clean = { misread: 0, hidden: 0, mismatchCost: 1.5 };
const visibleMatch = (state: ArrayLike<number>, truth: ArrayLike<number>, orient: number) => {
  let bad = 0;
  for (const slot of [F, U, R]) for (let cell = 0; cell < 9; cell++) if (state[VIEW[(orient * 6 + slot) * 9 + cell]] !== truth[VIEW[(orient * 6 + slot) * 9 + cell]]) bad++;
  return bad;
};

describe("snapToObservation", () => {
  it("builds a valid state that shows exactly the visible faces", () => {
    const truth = applyMoves(solvedState(), parseMoves("R U2 F' L D B2 R' U"));
    const obs = observe(truth, 0, [F, U, R], 1000, 900, rng(1), clean);
    const r = snapToObservation(solvedState(), 0, obs)!;
    expect(r.orient).toBe(0);
    expect(isValidState(r.state)).toBe(true);
    expect(visibleMatch(r.state, truth, 0)).toBe(0);
    expect(r.cost).toBe(0);
  });
});

describe("snapToObservation with sticker IDs", () => {
  it("picks the right pieces (not just colors) when only one face is visible", () => {
    const truth = applyMoves(solvedState(), parseMoves("R U R' U' F2 D L2 B' U2"));
    const ids = stickerIds(truth);
    const obs = observe(truth, 0, [F], 1000, 900, rng(4), clean);
    obs.faces[0].ids = Int16Array.from({ length: 9 }, (_, cell) => ids[VIEW[(0 * 6 + F) * 9 + cell]]);
    obs.faces[0].idCost = new Float32Array(9).fill(1);
    const r = snapToObservation(solvedState(), 0, obs)!;
    expect(r.cost).toBe(0);
    const got = stickerIds(r.state);
    for (let cell = 0; cell < 9; cell++) expect(got[VIEW[(0 * 6 + F) * 9 + cell]]).toBe(ids[VIEW[(0 * 6 + F) * 9 + cell]]);
  });
});

describe("TrackerEngine snapToView", () => {
  it("shows the visible colors at once, rebuilds tracking when lost, then keeps tracking from there", () => {
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS, { snapToView: true, decoder: { maxMovesPerStep: 3 } });
    const rnd = rng(2);
    expect(engine.observe(observe(solvedState(), 0, [F, U, R], 100, 50, rnd, clean)).view).toBeNull();
    // 見えない間に 8 手回した: 3D にはすぐ見えている色の状態を出す（追跡はまだ探している）
    let truth = applyMoves(solvedState(), parseMoves("R U2 F' L D B2 R' U"));
    let u = engine.observe(observe(truth, 0, [F, U, R], 1000, 900, rnd, clean));
    expect(u.view?.n).toBe(1);
    expect(visibleMatch(u.view!.state, truth, u.view!.orient)).toBe(0);
    // 同じ見え方が続いて追跡が見失ったら、追跡もその状態からやり直す
    for (let t = 1250; !u.base && t < 3000; t += 250) u = engine.observe(observe(truth, 0, [F, U, R], t, t - 100, rnd, clean));
    expect(u.base?.n).toBe(1);
    expect(u.view).toBeNull();
    expect(visibleMatch(u.state, truth, u.orient)).toBe(0);
    // その後の 1 手は、作り変えた状態から手として追う
    truth = applyMove(truth, parseMoves("F")[0]);
    const v = engine.observe(observe(truth, 0, [F, U, R], 4000, 3900, rnd, clean));
    expect(v.base?.n).toBe(1);
    expect(v.moves.length).toBe(u.moves.length + 1);
    expect(visibleMatch(v.state, truth, v.orient)).toBe(0);
  });

  it("does not rebuild on a single misread cell", () => {
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS, { snapToView: true });
    const rnd = rng(3);
    const obs = observe(solvedState(), 0, [F, U, R], 100, 50, rnd, clean);
    // 1 マスだけ読み違える
    obs.faces[0].labels[0] = 3;
    obs.faces[0].cost.fill(0, 0, 6);
    for (let c = 0; c < 6; c++) obs.faces[0].cost[c] = c === 3 ? 0 : 1.5;
    const u = engine.observe(obs);
    expect(u.base).toBeNull();
    expect(u.view).toBeNull();
    expect(engine.observe(observe(solvedState(), 0, [F, U, R], 300, 250, rnd, clean)).view).toBeNull();
  });

  // 実物の T-perm 2 回（遅いもの）: 色で補ったマスの読み違いが 2 観測続き、見えていない面まで作った状態で追跡を置き換えていて、
  // 手順は正しいのに最後の状態が揃っていなかった。作った状態は仮説に足すだけで、元の仮説も残す
  it("keeps the tracked hypothesis when a misread lasts only a couple of observations", () => {
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS, { snapToView: true });
    const rnd = rng(5);
    const truth = applyMoves(solvedState(), parseMoves("R U R'"));
    let t = 100;
    for (const m of parseMoves("R U R'")) {
      engine.observe(observe(applyMoves(solvedState(), [m]), 0, [F, U, R], t, t - 50, rnd, clean));
      t += 200;
    }
    // 同じ 2 マスを 2 観測読み違える
    const wrong = () => {
      const obs = observe(truth, 0, [F, U, R], t, t - 50, rnd, clean);
      for (const cell of [0, 1]) {
        obs.faces[0].labels[cell] = 3;
        for (let c = 0; c < 6; c++) obs.faces[0].cost[cell * 6 + c] = c === 3 ? 0 : 1.5;
      }
      t += 200;
      return obs;
    };
    engine.observe(wrong());
    let u = engine.observe(wrong());
    expect(u.base).not.toBeNull();
    // 読み違いが終われば、元の仮説（作り変えていない）に戻る
    for (let k = 0; k < 2; k++) {
      u = engine.observe(observe(truth, 0, [F, U, R], t, t - 50, rnd, clean));
      t += 200;
    }
    expect(u.base).toBeNull();
    expect(statesEqual(Uint8Array.from(u.state), truth)).toBe(true);
  });

  // 実物の T-perm 2 回（速いもの）: 見失って作り変えた後に揃えると、見えている面は揃っているのに見えていない面が推測のままだった
  it("prefers the solved state when a rebuilt cube shows solved faces", () => {
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS, { snapToView: true, decoder: { maxMovesPerStep: 3 } });
    const rnd = rng(6);
    const scrambled = applyMoves(solvedState(), parseMoves("R U2 F' L D B2 R' U"));
    let u = engine.observe(observe(scrambled, 0, [F], 100, 50, rnd, clean));
    for (let t = 300; !u.base && t < 3000; t += 250) u = engine.observe(observe(scrambled, 0, [F], t, t - 100, rnd, clean));
    expect(u.base).not.toBeNull();
    // 見えない間に揃えた（手順は追えない）: 見えている 2 面が揃っていれば揃った状態にする
    for (let t = 4000; t < 5000; t += 250) u = engine.observe(observe(solvedState(), 0, [F, U], t, t - 100, rnd, clean));
    expect(isSolved(Uint8Array.from(u.state))).toBe(true);
  });
});
