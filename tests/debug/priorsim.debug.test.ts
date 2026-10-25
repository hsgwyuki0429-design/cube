// 手順の知識（prior）の設定を、描画なしのデコーダだけのシミュレーションで比べる（速い）
//   npx vitest run -c vitest.debug.config.ts tests/debug/priorsim.debug.test.ts
import { it } from "vitest";
import { F2L, OLL, PLL, ALL_ALGORITHMS, toCenterMoves } from "../../src/cube/algorithms";
import { applyMove, applyMoves, invertMoves, solvedState } from "../../src/cube/model";
import { MoveDecoder } from "../../src/track/decoder";
import { MovePrior, type PriorOptions } from "../../src/track/prior";
import { ALL_MOVES, canonical, editDistance, observe, randomMove, rng, solveLikeSequence } from "../sim";

const LIB = { f2l: F2L.map(toCenterMoves), oll: OLL.map(toCenterMoves), pll: PLL.map(toCenterMoves) };
const CORPUS = ALL_ALGORITHMS.map(toCenterMoves);

function run(seq: number[], seed: number, prior: MovePrior | null, slots: number[], misread: number, hidden: number): number {
  const rnd = rng(seed * 13 + 5);
  const start = applyMoves(solvedState(), invertMoves(seq));
  const dec = new MoveDecoder(start, { priorWeight: prior ? 1 : 0 });
  dec.prior = prior;
  let state = start;
  let t = 0;
  const noise = { misread, hidden, mismatchCost: 1.5 };
  dec.observe(observe(state, 0, slots, t, t, rnd, noise));
  let i = 0;
  while (i < seq.length) {
    // 1 観測に 1〜2 手（速い所は 2 手）
    const k = rnd() < 0.3 ? 2 : 1;
    for (let j = 0; j < k && i < seq.length; j++) state = applyMove(state, seq[i++]);
    t += 200;
    dec.observe(observe(state, 0, slots, t, t - 100, rnd, noise));
  }
  const b = canonical(seq);
  return 1 - editDistance(canonical(dec.bestMoves().map((m) => m.move)), b) / Math.max(1, b.length);
}

it("prior variants", () => {
  const variants: [string, PriorOptions | null][] = [
    ["none", null],
    ...(JSON.parse(process.env.VARIANTS ?? "[[0.25,0.25],[0.15,0.15],[0.3,0],[0.1,0.3]]") as [number, number][]).map(([a, b]) => [`${a}/${b}`, { penalty4: a, penalty3: b }] as [string, PriorOptions]),
  ];
  const conds = [
    { name: "front-only", slots: [2], misread: 0.06, hidden: 0.2 },
    { name: "front+top", slots: [2, 0], misread: 0.06, hidden: 0.25 },
  ];
  for (const c of conds)
    for (const [name, opts] of variants) {
      const prior = opts ? new MovePrior(CORPUS, opts) : null;
      let rand = 0;
      let solve = 0;
      const N = Number(process.env.N ?? 12);
      for (let s = 1; s <= N; s++) {
        const r = rng(s);
        const randomSeq: number[] = [];
        for (let k = 0; k < 30; k++) randomSeq.push(randomMove(r, randomSeq[randomSeq.length - 1], ALL_MOVES));
        rand += run(randomSeq, s, prior, c.slots, c.misread, c.hidden);
        solve += run(solveLikeSequence(rng(s * 7 + 1), LIB, 6), s, prior, c.slots, c.misread, c.hidden);
      }
      process.stdout.write(`${c.name.padEnd(10)} ${name.padEnd(10)} random ${((rand / N) * 100).toFixed(1)}%  solve-like ${((solve / N) * 100).toFixed(1)}%\n`);
    }
}, 600000);
