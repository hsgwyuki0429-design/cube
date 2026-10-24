import { createRequire } from "node:module";
import { it } from "vitest";
import { MOVE_NAMES } from "../../src/cube/model";
import { initOpenCv } from "../../src/vision/quads";
import { simulate } from "../speed";
it("glare", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const r = simulate(cv, { seed: 1, moves: 10, tps: 4, fps: 30, exposureMs: 12, solveTo: true, refine: true, scene: { harshness: "real", fingers: "heavy", maskQuality: 0.5 } });
  const f = r.refined! as never as Record<string, unknown>;
  process.stdout.write(`truth ${r.truth.map((m) => MOVE_NAMES[m]).join(" ")} start ${r.startTruth} end ${r.endTruth}\n`);
  process.stdout.write(`refined start ${f.start} end ${f.end} solved ${f.solved} acc ${f.accuracy} moves ${(f.moves as { move: number; inferred?: boolean; start?: number; end?: number }[]).map((m) => `${MOVE_NAMES[m.move]}${m.inferred ? "?" : ""}[${Math.round(m.start ?? -1)}-${Math.round(m.end ?? -1)}]`).join(" ")}\n`);
}, 600000);
