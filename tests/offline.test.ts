// ソルブ後の再構成（前後両方向から解き直してつなぐ）: 途中で指が大きく隠しても、始まり（スクランブル後）と
// 終わり（完成）の両側から辻褄の合う手順を選べること。前向きだけ（リアルタイムと同じ）と比べる
import { describe, expect, it } from "vitest";
import { F, R, U, applyMove, applyMoves, invertMoves, isSolved, solvedState } from "../src/cube/model";
import { MoveDecoder } from "../src/track/decoder";
import { DEFAULT_OFFLINE, decodeOffline } from "../src/track/offline";
import type { Observation } from "../src/track/types";
import { ALL_MOVES, canonical, editDistance, observe, randomMove, rng } from "./sim";

function session(seed: number, moves: number, blackout: [number, number], perStep = () => 1, misread = 0.03) {
  const rnd = rng(seed);
  const truth: number[] = [];
  let prev: number | undefined;
  for (let i = 0; i < moves; i++) truth.push((prev = randomMove(rnd, prev, ALL_MOVES)));
  const start = applyMoves(solvedState(), invertMoves(truth));
  const obs: Observation[] = [];
  let state = start;
  let t = 0;
  const slots = [F, U, R];
  const clean = { misread, hidden: 0.1, mismatchCost: 1.5 };
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

  // 前後どちらも、まったく見えない同じ区間で見失う: 3 手 + 3 手の突き合わせでつなぐ（橋渡し）
  function hiddenStretch(seed: number, moves: number, b0: number, b1: number, perMove = 1, dark = { misread: 0, hidden: 1, mismatchCost: 1.5 }) {
    const rnd = rng(seed);
    const truth: number[] = [];
    let prev: number | undefined;
    for (let i = 0; i < moves; i++) truth.push((prev = randomMove(rnd, prev, ALL_MOVES)));
    const start = applyMoves(solvedState(), invertMoves(truth));
    const obs: Observation[] = [];
    let state = start;
    let t = 0;
    const clean = { misread: 0.03, hidden: 0.1, mismatchCost: 1.5 };
    obs.push(observe(state, 0, [F, U, R], t, t, rnd, clean));
    for (let i = 0; i < truth.length; i++) {
      state = applyMove(state, truth[i]);
      for (let j = 0; j < perMove; j++) {
        t += 200 / perMove;
        obs.push(observe(state, 0, [F, U, R], t, t - 150 / perMove, rnd, i >= b0 && i < b1 ? dark : clean));
      }
    }
    return { truth, start, obs, lastT: t };
  }

  it("bridges a stretch hidden from both directions", () => {
    for (const seed of [20, 32]) {
      const s = hiddenStretch(seed, 20, 6 + (seed % 5), 8 + (seed % 5) + (seed % 3));
      // 橋渡しを確かめるため 1 観測 3 手まで・候補 64（既定の 4 手まで・候補 128 では、この長さの隠れた区間は前後から直接つながる）
      const off = decodeOffline(s.obs, s.start, solvedState(), s.lastT, { ...DEFAULT_OFFLINE, decoder: { ...DEFAULT_OFFLINE.decoder, beamWidth: 64, maxMovesPerStep: 3, deepHyps: Number.POSITIVE_INFINITY } });
      expect(off.method).toBe("bridge");
      expect(isSolved(applyMoves(s.start, off.moves.map((m) => m.move)))).toBe(true);
      expect(acc(off.moves.map((m) => m.move), s.truth)).toBe(1);
    }
  });

  // 観測の多い長いソルブで長く隠れて、つなげない: 橋渡しの表を全観測ぶん持っていた間は数 GB 使って落ちた（iPhone でタブごと）。
  // いまは表を直近の分だけ持ち、時間の上限で打ち切る
  it("gives up bridging a long hidden stretch without blowing up memory", () => {
    const s = hiddenStretch(3, 40, 15, 30, 3, { misread: 0.4, hidden: 0.9, mismatchCost: 1.5 });
    const before = process.memoryUsage().heapUsed;
    let peak = 0;
    const t0 = performance.now();
    const off = decodeOffline(s.obs, s.start, solvedState(), s.lastT);
    peak = Math.max(peak, process.memoryUsage().heapUsed - before);
    expect(performance.now() - t0).toBeLessThan(40000);
    expect(peak / 1e6).toBeLessThan(400);
    expect(off.moves.length).toBeGreaterThan(0);
  }, 60000);
});

describe("最後に見えなかった手を足して完成までつなぐ（finishDeep）", () => {
  it("2 手では届かなくても 3 手・4 手まで足してつなぐ", async () => {
    const { MoveDecoder } = await import("../src/track/decoder");
    const { finishDeep } = await import("../src/track/offline");
    const { applyMoves, parseMoves, solvedState, statesEqual } = await import("../src/cube/model");
    const dec = new MoveDecoder(solvedState(), {}, [0]);
    const end = applyMoves(solvedState(), parseMoves("R U F' L"));
    const moves = finishDeep(dec, end, 1000);
    expect(moves).not.toBeNull();
    expect(moves!.every((m) => m.inferred)).toBe(true);
    expect(statesEqual(applyMoves(solvedState(), moves!.map((m) => m.move)), end)).toBe(true);
  }, 120000);
});

describe("必ず結果を出す", () => {
  it("始まりの状態が違っていても（スクランブルを間違えて回した）、完成から後ろ向きにたどった手順を返す", () => {
    for (let seed = 1; seed <= 4; seed++) {
      const { truth, start, obs, lastT } = session(seed, 30, [0, 0], () => 1, 0.01);
      // 渡す始まりの状態は、本当の状態とまったく違う（別のスクランブル）
      let wrong = start;
      for (const m of [0, 4, 8, 9, 13, 17, 2, 6, 11, 15, 3, 7, 12, 16, 1]) wrong = applyMove(wrong, m);
      const r = decodeOffline(obs, wrong, solvedState(), lastT);
      expect(r.method).toBe("backward");
      expect(r.reachedEnd).toBe(true);
      expect(Array.from(r.startState!)).toEqual(Array.from(start));
      expect(isSolved(applyMoves(start, r.moves.map((m) => m.move)))).toBe(true);
      expect(acc(r.moves.map((m) => m.move), truth)).toBeGreaterThan(0.9);
    }
  });

  it("どうしてもつながらないときも、後ろ向きに追えた終わりの手を返す（タイムの終わりを決められる）", () => {
    // 真ん中が長く隠れ、その間に何手も進む（橋渡しでも届かない）
    const { truth, start, obs, lastT } = session(21, 44, [10, 26], () => 2);
    const r = decodeOffline(obs, start, solvedState(), lastT, { decoder: { beamWidth: 32, maxMovesPerStep: 3, lostAfter: 1000 }, bridge: false });
    if (r.reachedEnd) return; // つながったなら確かめることはない
    expect(r.tail?.length).toBeGreaterThan(0);
    // 終わりの数手は本当の手順の終わりと同じ
    const tail = r.tail!.slice(-3).map((m) => m.move);
    expect(canonical(tail)).toEqual(canonical(truth.slice(-3)));
    expect(r.tail![r.tail!.length - 1].t).toBeGreaterThan(lastT - 1000);
  });

  // 解き直しが長くかかっても、本体の「止まった」の見張り（controller.endAnalysis の STALL_MS）に止められないよう、ときどき知らせる。
  // 録画の画質（720p・2.5Mbps）の実物のソルブで、後ろ向き + 橋渡しが知らせなしに Node で 18 秒（iPhone では見張りの 30 秒を超えた）
  it("解き直しの間、ときどき tick を呼ぶ（後ろ向き・橋渡しの間も）", () => {
    // 真ん中が長く隠れ、その間に何手も進む（後ろ向きは見失い、橋渡しも探す）
    const s = session(21, 44, [10, 26], () => 2);
    const at: number[] = [];
    decodeOffline(s.obs, s.start, solvedState(), s.lastT, { ...DEFAULT_OFFLINE, tick: () => at.push(performance.now()) });
    expect(at.length).toBeGreaterThan(s.obs.length / 2);
    let gap = 0;
    for (let i = 1; i < at.length; i++) gap = Math.max(gap, at[i] - at[i - 1]);
    expect(gap).toBeLessThan(2000);
  }, 60000);

  it("後ろ向きの時間の上限を超えても結果を出す（そこまでの後ろ向き・橋渡し・前向きを補う）", () => {
    const { start, obs, lastT } = session(9, 30, [12, 16]);
    const off = decodeOffline(obs, start, solvedState(), lastT, { ...DEFAULT_OFFLINE, backwardMs: 0 });
    expect(off.moves.length).toBeGreaterThan(0);
    expect(off.reachedEnd).toBe(true);
    expect(isSolved(applyMoves(start, off.moves.map((m) => m.move)))).toBe(true);
  });
});
