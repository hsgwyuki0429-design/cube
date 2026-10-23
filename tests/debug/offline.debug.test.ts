import { it } from "vitest";
import { F, R, U, applyMove, applyMoves, invertMoves, isSolved, solvedState } from "../../src/cube/model";
import { MoveDecoder } from "../../src/track/decoder";
import { decodeOffline } from "../../src/track/offline";
import type { Observation } from "../../src/track/types";
import { ALL_MOVES, canonical, editDistance, observe, randomMove, rng } from "../sim";

function session(seed: number, moves: number, blackout: [number, number], perStep: () => number) {
  const rnd = rng(seed);
  const truth: number[] = [];
  let prev: number | undefined;
  for (let i = 0; i < moves; i++) truth.push((prev = randomMove(rnd, prev, ALL_MOVES)));
  const start = applyMoves(solvedState(), invertMoves(truth));
  const obs: Observation[] = [];
  let state = start;
  let t = 0;
  const clean = { misread: 0.03, hidden: 0.1, mismatchCost: 1.5 };
  const dark = { misread: 0.2, hidden: 0.75, mismatchCost: 1.5 };
  obs.push(observe(state, 0, [F, U, R], t, t, rnd, clean));
  let i = 0;
  let step = 0;
  while (i < truth.length) {
    const k = Math.min(perStep(), truth.length - i);
    for (let j = 0; j < k; j++) state = applyMove(state, truth[i++]);
    step++;
    t += 200;
    obs.push(observe(state, 0, [F, U, R], t, t - 160, rnd, step >= blackout[0] && step < blackout[1] ? dark : clean));
  }
  for (let j = 0; j < 2; j++) obs.push(observe(state, 0, [F, U, R], (t += 200), t - 150, rnd, { misread: 0, hidden: 0, mismatchCost: 1.5 }));
  return { truth, start, obs, lastT: t };
}
const acc = (d: number[], t: number[]) => 1 - editDistance(canonical(d), canonical(t)) / Math.max(1, t.length);

it("offline configs", () => {
  const cfgs = JSON.parse(process.env.OFF_CFG ?? '[{"beamWidth":64,"maxMovesPerStep":3,"lostAfter":1000}]');
  for (const c of cfgs) {
    let fa = 0, oa = 0, end = 0, n = 0, t0 = performance.now(), methods: string[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const s = session(seed, 30, [10, 16], () => 1 + (seed % 2));
      const fwd = new MoveDecoder(s.start, { beamWidth: 32, maxMovesPerStep: 3 });
      for (const o of s.obs) fwd.observe(o);
      fa += acc((fwd.finish(solvedState(), s.lastT, 2) ?? fwd.bestMoves()).map((m) => m.move), s.truth);
      const off = decodeOffline(s.obs, s.start, solvedState(), s.lastT, { decoder: c });
      oa += acc(off.moves.map((m) => m.move), s.truth);
      methods.push(off.method);
      if (off.reachedEnd && isSolved(applyMoves(s.start, off.moves.map((m) => m.move)))) end++;
      n++;
    }
    process.stdout.write(`${JSON.stringify(c)} fwd=${((fa / n) * 100).toFixed(0)}% off=${((oa / n) * 100).toFixed(0)}% end=${end}/${n} ${methods.join(",")} ${((performance.now() - t0) / n / 1000).toFixed(1)}s/session\n`);
  }
});

it("profile", () => {
  const s = session(1, 30, [10, 16], () => 2);
  const dec = new MoveDecoder(s.start, { beamWidth: 64, maxMovesPerStep: 3, lostAfter: 1000 });
  const out: string[] = [];
  for (const o of s.obs) {
    const t0 = performance.now();
    dec.observe(o);
    out.push(`${dec.lastExpanded}/${(performance.now() - t0).toFixed(0)}ms`);
  }
  process.stdout.write(`profile ${out.join(" ")}\n`);
});

it("diag seed", async () => {
  const { statesEqual } = await import("../../src/cube/model");
  const seed = Number(process.env.SEED ?? 5);
  const s = session(seed, 30, [10, 16], () => 1 + (seed % 2));
  // 真の状態の列（観測ごと）
  const per = 1 + (seed % 2);
  const truthStates = [s.start];
  let st = s.start;
  let i = 0;
  while (i < s.truth.length) {
    for (let j = 0; j < per && i < s.truth.length; j++) st = applyMove(st, s.truth[i++]);
    truthStates.push(st);
  }
  truthStates.push(st, st);
  const fwd = new MoveDecoder(s.start, { beamWidth: 64, maxMovesPerStep: 3, lostAfter: 1000 });
  const fin: string[] = [];
  s.obs.forEach((o, k) => {
    fwd.observe(o);
    const has = fwd.hypotheses().findIndex((h) => statesEqual(h.state, truthStates[k]));
    fin.push(`${k}:${has}`);
  });
  process.stdout.write(`forward truth rank per obs: ${fin.join(" ")}\n`);
  const { reversedObservations } = await import("../../src/track/offline");
  const bwd = new MoveDecoder(solvedState(), { beamWidth: 64, maxMovesPerStep: 3, lostAfter: 1000 });
  const rev = reversedObservations(s.obs, s.lastT);
  const bin: string[] = [];
  rev.forEach((o, j) => {
    bwd.observe(o);
    const k = s.obs.length - 1 - j;
    bin.push(`${k}:${bwd.hypotheses().findIndex((h) => statesEqual(h.state, truthStates[k]))}`);
  });
  process.stdout.write(`backward truth rank per obs: ${bin.join(" ")}\n`);
});
