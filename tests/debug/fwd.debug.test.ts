// リアルタイム（前向き）・精密解析の前向きだけ・前後からつなぐ、の手順の一致を比べる（手順の知識の有無も）
//   FWD_CFG='[{"tps":4,"fps":30,"exp":12,"every":2,"tracked":true,"seeds":[1,2]}]' PRIOR=1 npx vitest run -c vitest.debug.config.ts tests/debug/fwd.debug.test.ts
import { createRequire } from "node:module";
import { it } from "vitest";
import { applyMoves, invertMoves, solvedState } from "../../src/cube/model";
import { DEFAULT_OFFLINE, decodeOffline } from "../../src/track/offline";
import { simplifyMoves } from "../../src/track/merge";
import { initOpenCv } from "../../src/vision/quads";
import { simulate } from "../speed";
import { canonical as canonicalMoves, editDistance, rng, solveLikeSequence } from "../sim";
import { F2L, OLL, PLL, toCenterMoves } from "../../src/cube/algorithms";

const LIB = { f2l: F2L.map(toCenterMoves), oll: OLL.map(toCenterMoves), pll: PLL.map(toCenterMoves) };

const cfgs = JSON.parse(process.env.FWD_CFG ?? "[]");
const pw = Number(process.env.PRIOR ?? 1);
it("forward vs live", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  for (const c of cfgs)
    for (const seed of c.seeds ?? [1]) {
      const sequence = c.solveLike ? solveLikeSequence(rng(seed * 7 + 1), LIB, c.cross ?? 6) : undefined;
      const r = simulate(cv, { seed, sequence, moves: c.moves ?? 16, tps: c.tps, fps: c.fps, exposureMs: c.exp ?? 0, solveTo: true, every: c.every, scene: c.scene, tracked: c.tracked, refine: true, engine: { decoder: { priorWeight: pw } } as never });
      const start = applyMoves(solvedState(), invertMoves(r.truth));
      const b = canonicalMoves(r.truth);
      const acc = (ms: number[]) => 1 - editDistance(canonicalMoves(ms), b) / Math.max(1, b.length);
      const fwd = decodeOffline(r.refiner!.engine.observationLog, start, null, r.refiner!.lastT, { decoder: { ...DEFAULT_OFFLINE.decoder, priorWeight: pw } });
      process.stdout.write(
        `${JSON.stringify({ ...c, seeds: undefined, seed })} prior=${pw} live=${(r.accuracy * 100).toFixed(0)}% fwd=${(acc(simplifyMoves(fwd.moves).map((m) => m.move)) * 100).toFixed(0)}% refine=${((r.refined?.accuracy ?? 0) * 100).toFixed(0)}% solved=${r.refined?.solved}\n`,
      );
    }
}, 7200000);
