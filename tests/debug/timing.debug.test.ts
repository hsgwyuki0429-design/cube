import { createRequire } from "node:module";
import { it } from "vitest";
import { MOVE_NAMES, moveFace } from "../../src/cube/model";
import { initOpenCv } from "../../src/vision/quads";
import { layerAtRest } from "../../src/track/timing";
import { simulate } from "../speed";

it("timing trace", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const tps = Number(process.env.TPS ?? 10);
  const fps = Number(process.env.FPS ?? 30);
  const r = simulate(cv, { seed: 1, moves: 20, tps, fps, exposureMs: 12, solveTo: true, engine: { logMs: Infinity } });
  const w = (s: string) => process.stdout.write(s + "\n");
  for (const [label, m, truthT] of [["first", r.decoded[0], r.startTruth], ["last", r.decoded[r.decoded.length - 1], r.endTruth]] as const) {
    const tm = r.engine.timing(m)!;
    w(`${label}: ${MOVE_NAMES[m.move]} orient=${m.orient} t0=${m.t0?.toFixed(0)} t=${m.t.toFixed(0)} -> start=${tm.start.toFixed(0)} end=${tm.end.toFixed(0)} truth=${truthT.toFixed(0)} truth-move=${MOVE_NAMES[label === "first" ? r.truth[0] : r.truth[r.truth.length - 1]]}`);
    for (const f of r.engine.frames) {
      if (Math.abs(f.t - truthT) > 260) continue;
      const rest = layerAtRest(f, m.orient, moveFace(m.move));
      const sp = f.faces.map((x) => `${x.slot}:[${x.spread?.map((v) => v.toFixed(0)).join(",")}]v${x.valid.map((v) => (v ? 1 : 0)).join("")}`).join(" ");
      w(`  t=${f.t.toFixed(0)} rest=${rest} ${sp}`);
    }
  }
  w(`decoded tail: ${r.decoded.slice(-4).map((m) => `${MOVE_NAMES[m.move]}@${m.t0?.toFixed(0)}-${m.t.toFixed(0)}`).join(" ")}  truth tail ${r.truth.slice(-4).map((m) => MOVE_NAMES[m]).join(" ")} end=${r.endTruth.toFixed(0)}`);
});
