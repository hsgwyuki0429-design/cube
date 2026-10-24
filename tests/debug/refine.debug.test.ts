import { createRequire } from "node:module";
import { it } from "vitest";
import { initOpenCv } from "../../src/vision/quads";
import { simulate } from "../speed";

// 遅い端末のリアルタイム追跡（every フレームに1枚）と、全フレームの精密解析を比べる
const cfgs = JSON.parse(process.env.REFINE_CFG ?? '[{"tps":10,"fps":60,"exp":8,"every":4,"seeds":[1,2]}]');
it("refine metrics", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  for (const c of cfgs) {
    for (const seed of c.seeds ?? [1]) {
      const t0 = performance.now();
      const r = simulate(cv, { seed, moves: c.moves ?? 20, tps: c.tps, fps: c.fps, exposureMs: c.exp ?? 0, solveTo: true, every: c.every, refine: true, gap: c.gap, eye: c.eye, engine: c.engine, scene: c.scene });
      const f = r.refined!;
      const liveFirst = r.decoded[0];
      const liveLast = r.decoded[r.decoded.length - 1];
      const ls = liveFirst ? r.engine.timing(liveFirst) : null;
      const le = liveLast ? r.engine.timing(liveLast) : null;
      process.stdout.write(
        `${JSON.stringify({ ...c, seeds: undefined, seed })} live acc=${(r.accuracy * 100).toFixed(0)}% final=${r.final} time err=${ls && le ? (le.end - ls.start - (r.endTruth - r.startTruth)).toFixed(0) : "-"} | refine acc=${(f.accuracy * 100).toFixed(0)}% solved=${f.solved} forced=${f.forced} method=${f.method} start=${((f.start ?? NaN) - r.startTruth).toFixed(0)} end=${((f.end ?? NaN) - r.endTruth).toFixed(0)} inferred=${f.inferred} ${((performance.now() - t0) / 1000).toFixed(0)}s\n`,
      );
      if (process.env.PRINT) process.stdout.write(`  truth=${r.truth.join(",")}\n  refin=${f.moves.map((m) => m.move + (m.inferred ? "?" : "")).join(",")}\n`);
    }
  }
}, 7200000);
