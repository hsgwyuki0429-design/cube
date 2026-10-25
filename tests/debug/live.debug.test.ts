// リアルタイムの追跡（ライブの 3D 表示に使う経路）だけの精度。実物らしい条件の合成映像で
//   LIVE_CFG='[{"tps":4,"fps":30,"exp":12,"every":2,"scene":{...},"seeds":[1,2]}]' npx vitest run -c vitest.debug.config.ts tests/debug/live.debug.test.ts
import { createRequire } from "node:module";
import { it } from "vitest";
import { initOpenCv } from "../../src/vision/quads";
import { simulate } from "../speed";

const cfgs = JSON.parse(process.env.LIVE_CFG ?? "[]");
it("live metrics", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  for (const c of cfgs)
    for (const seed of c.seeds ?? [1]) {
      const t0 = performance.now();
      const r = simulate(cv, { seed, moves: c.moves ?? 16, tps: c.tps, fps: c.fps, exposureMs: c.exp ?? 0, solveTo: true, every: c.every, scene: c.scene, tracked: c.tracked, pipeline: c.pipeline });
      process.stdout.write(`${JSON.stringify({ ...c, seeds: undefined, seed })} live acc=${(r.accuracy * 100).toFixed(0)}% final=${r.final} status=${r.engine.decoder.status} ${((performance.now() - t0) / 1000).toFixed(0)}s\n`);
    }
}, 7200000);
