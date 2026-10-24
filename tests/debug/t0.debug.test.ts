import { createRequire } from "node:module";
import { it } from "vitest";
import { initOpenCv } from "../../src/vision/quads";
import { simulate } from "../speed";

it("t0 check", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const r = simulate(cv, { seed: 2, moves: 10, tps: 10, fps: 60, exposureMs: 8, solveTo: true, every: 4, refine: true });
  const f = r.refined!;
  process.stdout.write(`truth start ${r.startTruth} end ${r.endTruth} method=${f.method} raw first ${JSON.stringify(f.raw?.slice(0, 2))} last ${JSON.stringify(f.raw?.slice(-1))}\n`);
  const obs = r.refiner!.engine.observationLog.slice(0, 4).map((o) => `[${o.tPrevEnd.toFixed(0)},${o.t.toFixed(0)}]`);
  process.stdout.write(`obs ${obs.join(" ")}\n`);
});

it("meet vs forward", async () => {
  const { MoveDecoder } = await import("../../src/track/decoder");
  const { decodeOffline, DEFAULT_OFFLINE } = await import("../../src/track/offline");
  const { solvedState, MOVE_NAMES } = await import("../../src/cube/model");
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const r = simulate(cv, { seed: 2, moves: 10, tps: 10, fps: 60, exposureMs: 8, solveTo: true, every: 4, refine: true });
  const log = r.refiner!.engine.observationLog;
  const start = Uint8Array.from(r.refiner!["input"].state);
  const fwd = new MoveDecoder(start, DEFAULT_OFFLINE.decoder);
  for (const o of log) fwd.observe(o);
  const fm = fwd.finish(solvedState(), r.refiner!.lastT, 2) ?? fwd.bestMoves();
  const off = decodeOffline(log, start, solvedState(), r.refiner!.lastT);
  process.stdout.write(`truth   ${r.truth.map((m) => MOVE_NAMES[m]).join(" ")}\nforward ${fm.map((m) => MOVE_NAMES[m.move]).join(" ")} cost=${fwd.costOffset.toFixed(2)}\noffline ${off.moves.map((m) => MOVE_NAMES[m.move]).join(" ")} method=${off.method} meetAt=${off.meetAt} cost=${off.cost.toFixed(2)}\n`);
});

it("bisect decoder", async () => {
  const { MoveDecoder } = await import("../../src/track/decoder");
  const { solvedState, MOVE_NAMES } = await import("../../src/cube/model");
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const r = simulate(cv, { seed: 2, moves: 10, tps: 10, fps: 60, exposureMs: 8, solveTo: true, every: 4, refine: true });
  const log = r.refiner!.engine.observationLog;
  const start = Uint8Array.from(r.refiner!["input"].state);
  for (const opts of [{ beamWidth: 64, maxMovesPerStep: 3, lostAfter: 1000 }, { beamWidth: 64, maxMovesPerStep: 3, lostAfter: 1000, deepenAbove: -1 }, { beamWidth: 64, maxMovesPerStep: 4 }, { beamWidth: 64, maxMovesPerStep: 4, deepenAbove: -1, recoveryDepth: 5 }]) {
    const fwd = new MoveDecoder(start, opts);
    for (const o of log) fwd.observe(o);
    const fm = fwd.finish(solvedState(), r.refiner!.lastT, 2) ?? fwd.bestMoves();
    process.stdout.write(`${JSON.stringify(opts)}: ${fm.map((m) => MOVE_NAMES[m.move]).join(" ")} cost=${fwd.costOffset.toFixed(2)}\n`);
  }
  const o2 = log[2];
  process.stdout.write(`obs2 t=${o2.t} faces=${o2.faces.map((f) => `${f.slot}:${Array.from(f.labels).join(",")}`).join(" ")}\n`);
});
