// ソルブ後の再構成（前後両方向から解き直してつなぐ）: 途中で指が大きく隠しても、始まり（スクランブル後）と
// 終わり（完成）の両側から辻褄の合う手順を選べること。前向きだけ（リアルタイムと同じ）と比べる
import { describe, expect, it } from "vitest";
import { F, R, U, applyMove, applyMoves, invertMoves, isSolved, solvedState } from "../src/cube/model";
import { MoveDecoder } from "../src/track/decoder";
import { decodeOffline } from "../src/track/offline";
import type { Observation } from "../src/track/types";
import { ALL_MOVES, canonical, editDistance, observe, randomMove, rng } from "./sim";

function session(seed: number, moves: number, blackout: [number, number], perStep = () => 1) {
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
  // 指で大きく隠れている区間: ほとんど見えず、見えても誤読が多い
  const dark = { misread: 0.2, hidden: 0.75, mismatchCost: 1.5 };
  obs.push(observe(state, 0, slots, t, t, rnd, clean));
  let i = 0;
  let step = 0;
  while (i < truth.length) {
    const k = Math.min(perStep(), truth.length - i);
    for (let j = 0; j < k; j++) state = applyMove(state, truth[i++]);
    step++;
    const tPrev = t + 40;
    t += 200;
    const noise = step >= blackout[0] && step < blackout[1] ? dark : clean;
    obs.push(observe(state, 0, slots, t, tPrev, rnd, noise));
  }
  for (let j = 0; j < 2; j++) {
    t += 200;
    obs.push(observe(state, 0, slots, t, t - 150, rnd, { misread: 0, hidden: 0, mismatchCost: 1.5 }));
  }
  return { truth, start, obs, lastT: t };
}

const acc = (decoded: number[], truth: number[]) => 1 - editDistance(canonical(decoded), canonical(truth)) / Math.max(1, truth.length);

describe("offline reconstruction (forward + backward meet)", () => {
  it("recovers moves hidden behind fingers in the middle of the solve", () => {
    let fwdSum = 0;
    let offSum = 0;
    let offEnd = 0;
    const N = 8;
    for (let seed = 1; seed <= N; seed++) {
      const s = session(seed, 30, [10, 16], () => 1 + (seed % 2));
      // リアルタイムと同じ前向きのみ（最後に完成へ合わせる）
      const fwd = new MoveDecoder(s.start, { beamWidth: 32, maxMovesPerStep: 3 });
      for (const o of s.obs) fwd.observe(o);
      const fm = fwd.finish(solvedState(), s.lastT, 2) ?? fwd.bestMoves();
      fwdSum += acc(fm.map((m) => m.move), s.truth);
      const off = decodeOffline(s.obs, s.start, solvedState(), s.lastT);
      offSum += acc(off.moves.map((m) => m.move), s.truth);
      if (off.reachedEnd && isSolved(applyMoves(s.start, off.moves.map((m) => m.move)))) offEnd++;
    }
    // 再構成は前向きのみより正確で、必ず完成にたどり着く手順を出す
    expect(offEnd).toBe(N);
    expect(offSum / N).toBeGreaterThanOrEqual(fwdSum / N);
    expect(offSum / N).toBeGreaterThan(0.9);
  });

  it("matches the forward result when nothing is hidden", () => {
    const s = session(42, 25, [99, 99]);
    const off = decodeOffline(s.obs, s.start, solvedState(), s.lastT);
    expect(acc(off.moves.map((m) => m.move), s.truth)).toBe(1);
    expect(off.reachedEnd).toBe(true);
  });
});
