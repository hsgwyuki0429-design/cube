import { createRequire } from "node:module";
import { it } from "vitest";
import { initOpenCv } from "../../src/vision/quads";
import { simulate } from "../speed";

const cfgs = JSON.parse(process.env.SPEED_CFG ?? "[]");
it("speed metrics", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  for (const c of cfgs) {
    const seeds = c.seeds ?? [1, 2, 3];
    const rs = seeds.map((seed: number) => {
      const t0 = performance.now();
      const r = simulate(cv, { engine: { logMs: Infinity, ...(c.engine ?? {}) },  seed, moves: c.moves ?? 20, tps: c.tps, fps: c.fps, exposureMs: c.exp ?? 0, solveTo: true, hands: c.hands, wobble: c.wobble, gap: c.gap, eye: c.eye, maskHands: c.mask });
      const first = r.decoded[0];
      const last = r.decoded[r.decoded.length - 1];
      const ts = first ? r.engine.timing(first) : null;
      const te = last ? r.engine.timing(last) : null;
      return { acc: r.accuracy, final: r.final, startErr: ts ? ts.start - r.startTruth : NaN, endErr: te ? te.end - r.endTruth : NaN, ms: (performance.now() - t0) / r.frames, obs: r.engine.decoder.observations, status: r.engine.decoder.status };
    });
    const acc = rs.reduce((s: number, r: { acc: number }) => s + r.acc, 0) / rs.length;
    process.stdout.write(
      `${JSON.stringify({ ...c, seeds: undefined })} acc=${(acc * 100).toFixed(1)}% final=${rs.filter((r: { final: boolean }) => r.final).length}/${rs.length} start=${rs.map((r: { startErr: number }) => r.startErr.toFixed(0)).join(",")} end=${rs.map((r: { endErr: number }) => r.endErr.toFixed(0)).join(",")} obs=${rs.map((r: { obs: number }) => r.obs).join(",")} ${rs.map((r: { status: string }) => r.status).join(",")} ${rs[0].ms.toFixed(0)}ms/frame\n`,
    );
  }
});
