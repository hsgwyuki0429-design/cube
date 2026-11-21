// 後ろ向きだけでたどり着いた始まりの状態の確かめ（src/track/startCheck.ts・offline.ts の startCheck・Refiner）:
// スクランブルを本当に間違えて回したときは救い（回し始める前の読みが案内と食い違い、後ろ向きの状態と合う）、後ろ向きが別の道に入って
// 違う始まりの状態に着いたとき・確かな読みがないときは「完成」にしない
import { beforeAll, describe, expect, it } from "vitest";
import { STICKERS, designOf } from "../src/aruco/design";
import { ARUCO_REFS } from "../src/aruco/palette";
import { VIEW, type Vec3, applyMoves, inverseMove, invertMoves, isSolved, parseMoves, solvedState, statesEqual } from "../src/cube/model";
import { stickerIds } from "../src/cube/stickers";
import { DEFAULT_OFFLINE, decodeOffline } from "../src/track/offline";
import { ARUCO_OBSERVER } from "../src/track/observer";
import { type StableFrame, judgeBackwardStart, stableFrames } from "../src/track/startCheck";
import type { CV } from "../src/vision/image";
import { Refiner } from "../src/vision/refine";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "./arucoCube";
import { loadTestOpenCv } from "./cv";
import { ALL_MOVES, observe, randomMove, rng } from "./sim";

// 状態 s を姿勢 o で見たときの、正面・上・右の確かな読み（9 マスずつ）のフレーム
function framesOf(s: Uint8Array, o: number, n: number, t0 = 0, slots = [2, 0, 1]): { t: number; faces: { slot: number; ids: number[]; w: number[] }[] }[] {
  const ids = stickerIds(s);
  return Array.from({ length: n }, (_, k) => ({
    t: t0 + k * 33,
    faces: slots.map((slot) => ({ slot, ids: Array.from({ length: 9 }, (_, c) => ids[VIEW[(o * 6 + slot) * 9 + c]]), w: new Array(9).fill(1) })),
  }));
}

describe("始まりの状態の確かめ（judgeBackwardStart）", () => {
  const given = applyMoves(solvedState(), parseMoves("R U F' L D2 B"));
  const actual = applyMoves(solvedState(), parseMoves("R U F' L D2 B'"));
  it("回し始める前の読みが案内と食い違い、後ろ向きの状態と合えば認める（スクランブルを間違えて回した）", () => {
    const fr = stableFrames(framesOf(actual, 0, 30));
    expect(fr.length).toBeGreaterThan(20);
    expect(judgeBackwardStart(actual, given, fr).ok).toBe(true);
  });
  it("後ろ向きの状態が読みと食い違えば認めない（案内どおりに回していた）", () => {
    const fr = stableFrames(framesOf(given, 0, 30));
    const v = judgeBackwardStart(actual, given, fr);
    expect(v.ok).toBe(false);
    expect(v.back).toBeGreaterThan(0);
  });
  it("確かな読みがない・案内と食い違う読みがなければ認めない", () => {
    expect(judgeBackwardStart(actual, given, []).ok).toBe(false);
    // 案内と後ろ向きの状態が見えている所では同じ（正面だけが見えていて、違うのは B2 で動く所だけ）: 間違えたとは読みから言えない
    const hidden = applyMoves(given, parseMoves("B2"));
    const fr = stableFrames(framesOf(given, 0, 30, 0, [2]));
    expect(contradictionsOf(hidden, fr)).toBe(0);
    expect(judgeBackwardStart(hidden, given, fr).ok).toBe(false);
  });
  it("持ち替えても（姿勢が変わっても）同じ状態なら食い違わない", () => {
    const fr = stableFrames([...framesOf(actual, 0, 10), ...framesOf(actual, 5, 10, 400), ...framesOf(actual, 13, 10, 800)]);
    expect(judgeBackwardStart(actual, given, fr).ok).toBe(true);
  });
});

function contradictionsOf(s: Uint8Array, fr: StableFrame[]): number {
  return judgeBackwardStart(s, s, fr).back;
}

describe("decodeOffline の startCheck", () => {
  // 観測の列（offline.test.ts の session と同じ作り）
  function session(seed: number) {
    const rnd = rng(seed);
    const truth: number[] = [];
    let prev: number | undefined;
    for (let i = 0; i < 30; i++) truth.push((prev = randomMove(rnd, prev, ALL_MOVES)));
    const start = applyMoves(solvedState(), invertMoves(truth));
    const obs = [];
    let state = start;
    let t = 0;
    const clean = { misread: 0.01, hidden: 0.1, mismatchCost: 1.5 };
    obs.push(observe(state, 0, [2, 0, 1], t, t, rnd, clean));
    for (const m of truth) {
      state = applyMoves(state, [m]);
      t += 200;
      obs.push(observe(state, 0, [2, 0, 1], t, t - 160, rnd, clean));
    }
    for (let j = 0; j < 2; j++) {
      t += 200;
      obs.push(observe(state, 0, [2, 0, 1], t, t - 150, rnd, { misread: 0, hidden: 0, mismatchCost: 1.5 }));
    }
    return { truth, start, obs, lastT: t };
  }
  it("認めなければ後ろ向きだけの答えを返さない（認めれば今までどおり）", () => {
    const { start, obs, lastT } = session(3);
    expect(isSolved(applyMoves(start, []))).toBe(false);
    let wrong = start;
    for (const m of [0, 4, 8, 9, 13, 17, 2, 6, 11, 15]) wrong = applyMoves(wrong, [m]);
    const seen: number[] = [];
    const ok = decodeOffline(obs, wrong, solvedState(), lastT, { ...DEFAULT_OFFLINE, startCheck: (s, until) => (seen.push(until), statesEqual(s, start)) });
    expect(ok.method).toBe("backward");
    expect(Array.from(ok.startState!)).toEqual(Array.from(start));
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeGreaterThan(0);
    const no = decodeOffline(obs, wrong, solvedState(), lastT, { ...DEFAULT_OFFLINE, startCheck: () => false });
    expect(no.method).not.toBe("backward");
    expect(no.startState).toBeUndefined();
  }, 60000);
  it("時間の上限（deadline）を過ぎたら、終わりに届かないまま打ち切る", () => {
    const { obs, lastT, start } = session(5);
    let wrong = start;
    for (const m of [0, 4, 8, 9, 13, 17, 2, 6, 11, 15]) wrong = applyMoves(wrong, [m]);
    const t0 = performance.now();
    const r = decodeOffline(obs, wrong, solvedState(), lastT, { ...DEFAULT_OFFLINE, startCheck: () => false, deadline: performance.now() - 1 });
    expect(r.timedOut).toBe(true);
    expect(r.reachedEnd).toBe(false);
    expect(performance.now() - t0).toBeLessThan(5000);
  }, 60000);
});

describe("精密解析（Refiner）: スクランブルを間違えて回したときは救う", () => {
  let cv: CV;
  beforeAll(async () => {
    cv = await loadTestOpenCv();
  }, 120000);
  const SIZE = { width: 960, height: 720 };
  const EYE: Vec3 = [2.4, 2.4, 5.5];
  // 本当に回したのは "R U F' D"、案内はまったく別のスクランブル（15 手離れた状態）。インスペクション（inspectMs）の後、完成まで回す
  // （案内と数手しか違わなければ、前向きが最初の観測でその手を回したと説明してつながる: B の直し）
  function run(inspectMs: number) {
    const actualScramble = parseMoves("R U F' D");
    const given = applyMoves(solvedState(), [...actualScramble, 0, 4, 8, 9, 13, 17, 2, 6, 11, 15, 3, 7, 12, 16, 1]);
    const actual = applyMoves(solvedState(), actualScramble);
    const solve = [...actualScramble].reverse().map(inverseMove);
    // 本体と同じステッカー（STICKERS）と精密解析の追跡の設定（controller.engineOptions）
    const refiner = new Refiner(cv, { state: Array.from(given), refs: ARUCO_REFS, from: 0, to: Infinity, engine: { observer: ARUCO_OBSERVER, decoder: { beamWidth: 32, maxMovesPerStep: 3, rotationCost: 1.5 } }, pipeline: { ...STICKERS } });
    let st = solvedStickers();
    for (const m of actualScramble) st = applyMoveStickers(st, m);
    const memoryEye = (t: number): Vec3 => [EYE[0] + 0.15 * Math.sin(t / 250), EYE[1], EYE[2]];
    const period = 420;
    const turnMs = 170;
    const total = inspectMs + solve.length * period + 500;
    let done = 0;
    for (let t = 0; t <= total; t += 1000 / 30) {
      while (done < solve.length && t >= inspectMs + done * period + turnMs) st = applyMoveStickers(st, solve[done++]);
      const s = inspectMs + done * period;
      const turning = done < solve.length && t >= s;
      const img = renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: memoryEye(t), turn: turning ? { move: solve[done], fraction: (t - s) / turnMs, spread: 0.15 } : undefined, noise: 2, seed: Math.round(t) + 1, scheme: "unique54", design: designOf(STICKERS.arucoDesign) });
      refiner.push(img, t);
    }
    return { refiner, actual, given };
  }
  it("インスペクション中の読みが本当の状態と合えば、完成から後ろ向きにたどった手順と始まりの状態を返す", () => {
    const { refiner, actual } = run(1500);
    const r = refiner.result(solvedState());
    expect(r.solved).toBe(true);
    expect(r.method).toBe("backward");
    expect(r.startState).toEqual(Array.from(actual));
    expect(refiner.startVerdict?.ok).toBe(true);
    expect(refiner.startVerdict!.given).toBeGreaterThan(0);
  }, 300000);
  it("回し始める前の読みがなければ（インスペクションなし）、後ろ向きだけの答えを完成にしない", () => {
    const { refiner } = run(0);
    const r = refiner.result(solvedState());
    expect(r.startState).toBeUndefined();
    expect(r.method).not.toBe("backward");
  }, 300000);
});
