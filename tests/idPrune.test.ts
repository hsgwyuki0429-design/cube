// 読んだステッカーの ID による枝刈り（src/track/decoder.ts）は、結果を変えずに速くするだけ: 枝刈りあり・なしで、観測のたびに残る仮説
// （状態・姿勢・コスト・手順）が同じこと
import { describe, expect, it } from "vitest";
import { F, R, U, VIEW, applyMove, rotateOrientation, type CubeState } from "../src/cube/model";
import { stickerIdAt } from "../src/cube/stickers";
import { MoveDecoder, type DecoderOptions } from "../src/track/decoder";
import type { Observation } from "../src/track/types";
import { ALL_MOVES, randomMove, rng, scrambled } from "./sim";

// ステッカーの ID つきの観測（ArUco unique54 の読みと同じ形）。hidden: 読めないマス・misread: 別のステッカーに読んだマス・
// colorOnly: 色だけ読めたマス（色で補ったマス）
function observeIds(state: CubeState, orient: number, slots: number[], t: number, tPrevEnd: number, rnd: () => number, noise: { hidden: number; misread: number; colorOnly: number }): Observation {
  const faces = slots.map((slot) => {
    const cost = new Float32Array(54);
    const labels = new Int8Array(9).fill(-1);
    const ids = new Int16Array(9).fill(-1);
    const idCost = new Float32Array(9);
    for (let cell = 0; cell < 9; cell++) {
      if (rnd() < noise.hidden) continue;
      const f = VIEW[(orient * 6 + slot) * 9 + cell];
      let id = stickerIdAt(state, f);
      if (rnd() < noise.misread) id = Math.floor(rnd() * 54);
      const w = 0.6 + 0.4 * rnd();
      labels[cell] = Math.floor(id / 9);
      for (let c = 0; c < 6; c++) cost[cell * 6 + c] = c === labels[cell] ? 0 : 1.5 * w;
      if (rnd() < noise.colorOnly) continue;
      ids[cell] = id;
      idCost[cell] = w;
    }
    return { slot, cost, labels, ids, idCost };
  });
  return { t, tPrevEnd, faces };
}

const summary = (d: MoveDecoder) =>
  d.hypotheses().map((h) => {
    const moves: number[] = [];
    for (let n = h.tail; n; n = n.prev) moves.push(n.move);
    return `${h.orient}:${Array.from(h.state).join("")}:${h.cost.toFixed(4)}:${h.obsCost.toFixed(4)}:${moves.reverse().join(",")}`;
  });

function compare(seed: number, options: Partial<DecoderOptions>, slots: number[], steps: number, maxPerStep: number, rotate = false) {
  const rnd = rng(seed);
  let state = scrambled(rnd);
  let orient = 0;
  const pruned = new MoveDecoder(state, { ...options, idPrune: true }, [0]);
  const plain = new MoveDecoder(state, { ...options, idPrune: false }, [0]);
  let prev: number | undefined;
  let t = 0;
  let msPruned = 0;
  let msPlain = 0;
  for (let step = 0; step < steps; step++) {
    const k = Math.floor(rnd() * (maxPerStep + 1));
    for (let i = 0; i < k; i++) {
      prev = randomMove(rnd, prev, ALL_MOVES);
      state = applyMove(state, prev);
    }
    if (rotate && rnd() < 0.15) orient = rotateOrientation(orient, "y", 1);
    t += 300;
    const obs = observeIds(state, orient, slots.filter(() => rnd() < 0.85 || slots.length === 1), t, t - 250, rnd, { hidden: 0.25, misread: 0.03, colorOnly: 0.1 });
    if (!obs.faces.length) continue;
    let a = performance.now();
    pruned.observe(obs);
    msPruned += performance.now() - a;
    a = performance.now();
    plain.observe(obs);
    msPlain += performance.now() - a;
    expect(summary(pruned)).toEqual(summary(plain));
    expect(pruned.status).toBe(plain.status);
  }
  return { msPruned, msPlain, evalsPruned: pruned.lastExpanded, evalsPlain: plain.lastExpanded };
}

describe("読んだステッカーの ID による枝刈り", () => {
  it("3 手まで・3 面: 枝刈りなしと同じ仮説が残る", () => {
    let p = 0;
    let q = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const r = compare(seed, {}, [F, U, R], 25, 3);
      p += r.msPruned;
      q += r.msPlain;
    }
    console.log(`3 手まで: 枝刈りあり ${p.toFixed(0)}ms・なし ${q.toFixed(0)}ms`);
  });

  it("4 手まで・持ち替え・手順の知識なし・見失いからの復帰も同じ", () => {
    let p = 0;
    let q = 0;
    for (let seed = 11; seed <= 12; seed++) {
      const r = compare(seed, { maxMovesPerStep: 4, beamWidth: 8, priorWeight: 0 }, [F, U, R], 15, 5, true);
      p += r.msPruned;
      q += r.msPlain;
    }
    console.log(`4 手まで: 枝刈りあり ${p.toFixed(0)}ms・なし ${q.toFixed(0)}ms`);
  });

  it("正面だけ・上位 4 仮説だけ深く（ライブの設定）でも同じ", () => {
    for (let seed = 21; seed <= 22; seed++) compare(seed, { priorWeight: 0, confirmMargin: 1, deepHyps: 4 }, [F], 30, 3, true);
  });
});
