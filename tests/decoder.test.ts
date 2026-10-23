import { describe, expect, it } from "vitest";
import { B, D, F, L, R, U, applyMove, moveFace, rotateOrientation, statesEqual } from "../src/cube/model";
import { MoveDecoder } from "../src/track/decoder";
import { ALL_MOVES, canonical, editDistance, observe, randomMove, rng, scrambled } from "./sim";

interface RunResult {
  accuracy: number;
  finalOk: boolean;
  lost: boolean;
}

function run(opts: {
  seed: number;
  steps: number;
  slots: number[];
  allowed: number[];
  movesPerStep: () => number;
  misread: number;
  hidden: number;
  rotateEvery?: number;
  orient?: number;
}): RunResult {
  const rnd = rng(opts.seed);
  let state = scrambled(rnd);
  let orient = opts.orient ?? 0;
  const decoder = new MoveDecoder(state);
  const truth: number[] = [];
  let t = 0;
  let prev: number | undefined;
  const noise = { misread: opts.misread, hidden: opts.hidden, mismatchCost: 1.5 };
  decoder.observe(observe(state, orient, opts.slots, t, t, rnd, noise));
  for (let step = 0; step < opts.steps; step++) {
    const k = opts.movesPerStep();
    for (let i = 0; i < k; i++) {
      prev = randomMove(rnd, prev, opts.allowed);
      state = applyMove(state, prev);
      truth.push(prev);
    }
    if (opts.rotateEvery && step % opts.rotateEvery === opts.rotateEvery - 1) {
      orient = rotateOrientation(orient, (["x", "y", "z"] as const)[Math.floor(rnd() * 3)], 1 + Math.floor(rnd() * 3));
    }
    const tPrev = t + 50;
    t += 300;
    decoder.observe(observe(state, orient, opts.slots, t, tPrev, rnd, noise));
  }
  // 最後に静止して何度か見る（ノイズなし）
  for (let i = 0; i < 3; i++) {
    t += 300;
    decoder.observe(observe(state, orient, opts.slots, t, t - 250, rnd, { ...noise, misread: 0, hidden: 0 }));
  }
  const decoded = decoder.bestMoves().map((m) => m.move);
  const a = canonical(decoded);
  const b = canonical(truth);
  return {
    accuracy: 1 - editDistance(a, b) / Math.max(1, b.length),
    finalOk: statesEqual(decoder.best().state, state) && decoder.best().orient === orient,
    lost: decoder.status === "lost",
  };
}

function summarize(results: RunResult[]) {
  return {
    accuracy: results.reduce((s, r) => s + r.accuracy, 0) / results.length,
    finalOk: results.filter((r) => r.finalOk).length / results.length,
  };
}

const FACE_MOVES = (faces: number[]) => ALL_MOVES.filter((m) => faces.includes(moveFace(m)));

describe("MoveDecoder (simulation)", () => {
  it("正面だけ・ノイズなし・1手ずつ・B 以外の手は完全に復元できる", () => {
    const res = Array.from({ length: 10 }, (_, k) =>
      run({ seed: 10 + k, steps: 30, slots: [F], allowed: FACE_MOVES([U, D, R, L, F]), movesPerStep: () => 1, misread: 0, hidden: 0 }),
    );
    const s = summarize(res);
    expect(s.accuracy).toBeGreaterThan(0.97);
    expect(s.finalOk).toBeGreaterThan(0.85);
  });

  it("正面 + 上面（スタンド固定）・誤読3%・隠れ10%・1〜2手ずつ・全18手", () => {
    let r = rng(99);
    const res = Array.from({ length: 12 }, (_, k) =>
      run({
        seed: 200 + k,
        steps: 30,
        slots: [F, U],
        allowed: ALL_MOVES,
        movesPerStep: () => (r() < 0.3 ? 2 : 1),
        misread: 0.03,
        hidden: 0.1,
      }),
    );
    const s = summarize(res);
    expect(s.accuracy).toBeGreaterThan(0.9);
    expect(s.finalOk).toBeGreaterThan(0.75);
  });

  it("正面 + 上面 + 右面・ノイズあり・2手ずつでも追える", () => {
    const res = Array.from({ length: 8 }, (_, k) =>
      run({ seed: 300 + k, steps: 25, slots: [F, U, R], allowed: ALL_MOVES, movesPerStep: () => 2, misread: 0.02, hidden: 0.1 }),
    );
    const s = summarize(res);
    expect(s.accuracy).toBeGreaterThan(0.9);
    expect(s.finalOk).toBeGreaterThan(0.75);
  });

  it("持ち替え（全体回転）を挟んでも追える", () => {
    const res = Array.from({ length: 8 }, (_, k) =>
      run({ seed: 400 + k, steps: 30, slots: [F, U], allowed: ALL_MOVES, movesPerStep: () => 1, misread: 0.01, hidden: 0.05, rotateEvery: 6 }),
    );
    const s = summarize(res);
    expect(s.accuracy).toBeGreaterThan(0.85);
    expect(s.finalOk).toBeGreaterThan(0.7);
  });

  it("初期姿勢が未知でも最初の観測で決まる", () => {
    const rnd = rng(5);
    const state = scrambled(rnd);
    const orient = rotateOrientation(rotateOrientation(0, "x"), "y", 3);
    const decoder = new MoveDecoder(state);
    decoder.observe(observe(state, orient, [F, U], 0, 0, rnd, { misread: 0, hidden: 0, mismatchCost: 1.5 }));
    expect(decoder.best().orient).toBe(orient);
    expect(decoder.bestMoves()).toEqual([]);
  });

  it("見えない B 面の回転は、後で見えた時点で遡って推定される", () => {
    const rnd = rng(8);
    let state = scrambled(rnd);
    const decoder = new MoveDecoder(state, {}, [0]);
    const noise = { misread: 0, hidden: 0, mismatchCost: 1.5 };
    decoder.observe(observe(state, 0, [F], 0, 0, rnd, noise));
    state = applyMove(state, B * 3); // B: カメラからは見えない
    decoder.observe(observe(state, 0, [F], 300, 100, rnd, noise));
    state = applyMove(state, U * 3); // U: B 面のステッカーが F 面に回り込むわけではないが、上段が入れ替わる
    decoder.observe(observe(state, 0, [F], 600, 400, rnd, noise));
    state = applyMove(state, U * 3);
    decoder.observe(observe(state, 0, [F], 900, 700, rnd, noise));
    expect(statesEqual(decoder.best().state, state)).toBe(true);
    expect(canonical(decoder.bestMoves().map((m) => m.move))).toEqual(canonical([B * 3, U * 3, U * 3]));
  });

  it("3手以上見逃しても、復帰探索で追跡を取り戻す", () => {
    const rnd = rng(12);
    let state = scrambled(rnd);
    const decoder = new MoveDecoder(state, {}, [0]);
    const noise = { misread: 0, hidden: 0, mismatchCost: 1.5 };
    decoder.observe(observe(state, 0, [F, U], 0, 0, rnd, noise));
    for (const m of [R * 3, U * 3 + 2, F * 3 + 1]) state = applyMove(state, m); // 3手まとめて
    for (let i = 0; i < 4; i++) decoder.observe(observe(state, 0, [F, U], 300 * (i + 1), 300 * i + 100, rnd, noise));
    expect(decoder.status).toBe("tracking");
    expect(statesEqual(decoder.best().state, state)).toBe(true);
  });

  it("1回の観測に3〜4手分のステップ時間で収まる（性能）", () => {
    const rnd = rng(3);
    const state = scrambled(rnd);
    const decoder = new MoveDecoder(state);
    const t0 = performance.now();
    decoder.observe(observe(state, 0, [F, U, R], 0, 0, rnd, { misread: 0, hidden: 0, mismatchCost: 1.5 }));
    for (let i = 0; i < 10; i++) decoder.observe(observe(applyMove(state, i % 18), 0, [F, U, R], 300 * i, 300 * i - 200, rnd, { misread: 0, hidden: 0, mismatchCost: 1.5 }));
    const per = (performance.now() - t0) / 11;
    expect(per).toBeLessThan(150);
  });
});
