// 深く探す（src/track/decoder.ts の bridgeDepth）: ライブはフレームを落とすので、速い手順では 1 つの観測に 4〜5 手入る。
// 読んだステッカーの ID がすべて合う手順だけを、手順の木（3 手まで）より深く探す
import { describe, expect, it } from "vitest";
import { F, R, U, VIEW, applyMove, statesEqual, type CubeState } from "../src/cube/model";
import { stickerIdAt } from "../src/cube/stickers";
import { MoveDecoder } from "../src/track/decoder";
import type { Observation } from "../src/track/types";
import { ALL_MOVES, randomMove, rng, scrambled } from "./sim";

// ステッカーの ID つきの観測（ライブと同じ重み: 1 フレームの観測 0.6 × ID を強く信じる 2）
function observeIds(state: CubeState, slots: number[], t: number, hidden: (cell: number, slot: number) => boolean): Observation {
  const w = 1.2;
  const faces = slots.map((slot) => {
    const cost = new Float32Array(54);
    const labels = new Int8Array(9).fill(-1);
    const ids = new Int16Array(9).fill(-1);
    const idCost = new Float32Array(9);
    for (let cell = 0; cell < 9; cell++) {
      if (hidden(cell, slot)) continue;
      const id = stickerIdAt(state, VIEW[slot * 9 + cell]);
      labels[cell] = Math.floor(id / 9);
      for (let c = 0; c < 6; c++) cost[cell * 6 + c] = c === labels[cell] ? 0 : 1.5 * w;
      ids[cell] = id;
      idCost[cell] = w;
    }
    return { slot, cost, labels, ids, idCost };
  });
  return { t, tPrevEnd: t - 250, faces };
}

function run(seed: number, gap: number, bridgeDepth: number) {
  const rnd = rng(seed);
  let state = scrambled(rnd);
  const decoder = new MoveDecoder(state, { priorWeight: 0, confirmMargin: 1, deepHyps: 4, bridgeDepth }, [0]);
  const truth: number[] = [];
  let prev: number | undefined;
  let t = 0;
  const hidden = (cell: number) => rnd() < 0.15 && cell !== 4;
  decoder.observe(observeIds(state, [F, U, R], t, hidden));
  for (let step = 0; step < 6; step++) {
    // 1 手ずつ 2 回、その後に gap 手まとめて
    for (const k of [1, 1, gap]) {
      for (let i = 0; i < k; i++) {
        prev = randomMove(rnd, prev, ALL_MOVES);
        state = applyMove(state, prev);
        truth.push(prev);
      }
      t += 300;
      decoder.observe(observeIds(state, [F, U, R], t, hidden));
    }
  }
  // 手順は同じ状態になる別の書き方（F2 B F' B = F B2 など）のことがあるので、状態で確かめる。手数は回した手より多くならない
  return { stateOk: statesEqual(decoder.best().state, state), short: decoder.bestMoves().length <= truth.length, status: decoder.status };
}

describe("深く探す（bridgeDepth）", () => {
  it("観測の間に 5 手入っても、読んだステッカーから手順を見つける", () => {
    let ok = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const r = run(seed, 5, 5);
      if (r.stateOk && r.short) ok++;
    }
    expect(ok).toBe(8);
  });

  it("深く探さなければ 5 手は追えない（3 手まで）", () => {
    let ok = 0;
    for (let seed = 1; seed <= 8; seed++) if (run(seed, 5, 0).stateOk) ok++;
    expect(ok).toBeLessThanOrEqual(2);
  });

  it("4 手も同じ", () => {
    let ok = 0;
    for (let seed = 11; seed <= 18; seed++) if (run(seed, 4, 5).stateOk) ok++;
    expect(ok).toBeGreaterThanOrEqual(7);
  });

  it("速い: 5 手まで探しても 1 観測 30ms 未満", () => {
    const rnd = rng(5);
    let state = scrambled(rnd);
    const decoder = new MoveDecoder(state, { priorWeight: 0, confirmMargin: 1, deepHyps: 4, bridgeDepth: 5 }, [0]);
    decoder.observe(observeIds(state, [F, U, R], 0, () => false));
    let prev: number | undefined;
    let worst = 0;
    for (let step = 1; step <= 6; step++) {
      for (let i = 0; i < 5; i++) {
        prev = randomMove(rnd, prev, ALL_MOVES);
        state = applyMove(state, prev);
      }
      const obs = observeIds(state, [F, U, R], step * 300, () => false);
      const a = performance.now();
      decoder.observe(obs);
      if (step > 1) worst = Math.max(worst, performance.now() - a);
    }
    expect(statesEqual(decoder.best().state, state)).toBe(true);
    expect(worst).toBeLessThan(30);
  });
});
