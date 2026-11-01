// 解き直しの橋渡し（前後どちらも隠れた区間で見失ったとき）のメモリと時間。観測の多い長いソルブで、指で大きく隠れた区間がある場合
//   node --expose-gc ./node_modules/vitest/vitest.mjs run -c vitest.debug.config.ts tests/debug/bridgeMem.debug.test.ts --silent=false
import { it } from "vitest";
import { F, R, U, applyMove, applyMoves, invertMoves, solvedState } from "../../src/cube/model";
import { decodeOffline } from "../../src/track/offline";
import type { Observation } from "../../src/track/types";
import { ALL_MOVES, observe, randomMove, rng } from "../sim";

function session(seed: number, moves: number, blackout: [number, number], obsPerMove: number) {
  const rnd = rng(seed);
  const truth: number[] = [];
  let prev: number | undefined;
  for (let i = 0; i < moves; i++) truth.push((prev = randomMove(rnd, prev, ALL_MOVES)));
  const start = applyMoves(solvedState(), invertMoves(truth));
  const obs: Observation[] = [];
  let state = start;
  let t = 0;
  const slots = [F, U, R];
  const clean = { misread: 0.03, hidden: 0.1, mismatchCost: 1.5 };
  const dark = { misread: 0.4, hidden: 0.9, mismatchCost: 1.5 };
  obs.push(observe(state, 0, slots, t, t, rnd, clean));
  for (let i = 0; i < truth.length; i++) {
    state = applyMove(state, truth[i]);
    for (let j = 0; j < obsPerMove; j++) {
      t += 60;
      obs.push(observe(state, 0, slots, t, t - 30, rnd, i >= blackout[0] && i < blackout[1] ? dark : clean));
    }
  }
  t += 200;
  obs.push(observe(state, 0, slots, t, t - 150, rnd, { misread: 0, hidden: 0, mismatchCost: 1.5 }));
  return { start, obs, lastT: t };
}

it("橋渡しのメモリ", () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  const mem = () => {
    gc?.();
    return process.memoryUsage().heapUsed / 1e6;
  };
  for (const [moves, blackout, per] of [
    [40, [15, 30], 3],
    [40, [15, 18], 3],
    [60, [20, 22], 4],
    [60, [10, 50], 4],




  ] as [number, [number, number], number][]) {
    const s = session(3, moves, blackout, per);
    const base = mem();
    let peak = 0;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed / 1e6 - base)), 5);
    const t0 = performance.now();
    const off = decodeOffline(s.obs, s.start, solvedState(), s.lastT);
    const ms = performance.now() - t0;
    clearInterval(timer);
    const after = process.memoryUsage().heapUsed / 1e6 - base;
    process.stdout.write(`moves ${moves} obs ${s.obs.length}: ${off.method} ${ms.toFixed(0)}ms heap after +${after.toFixed(0)}MB rss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB\n`);
  }
}, 3600000);
