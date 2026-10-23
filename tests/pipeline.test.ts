import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMove, statesEqual, type Vec3 } from "../src/cube/model";
import { rgbToLab, type Lab } from "../src/vision/color";
import { DEFAULT_PIPELINE, processFrame } from "../src/vision/pipeline";
import { type CV, initOpenCv } from "../src/vision/quads";
import { TrackerEngine } from "../src/track/engine";
import { PALETTE, renderCube } from "./render";
import { ALL_MOVES, canonical, editDistance, randomMove, rng, scrambled } from "./sim";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

const REFS: Lab[] = PALETTE.map(([r, g, b]) => rgbToLab(r * 0.85, g * 0.85, b * 0.85));

function session(seed: number, eye: Vec3, moves: number, orient = 0) {
  const rnd = rng(seed);
  let state = scrambled(rnd);
  const engine = new TrackerEngine(state, REFS);
  const memory = { last: null };
  let t = 0;
  let frameSeed = seed * 1000;
  const frame = (occluded: boolean) => {
    const img = renderCube({
      width: 640,
      height: 480,
      state,
      orient,
      eye,
      seed: frameSeed++,
      occluders: occluded ? [{ center: [300 + rnd() * 60, 250 + rnd() * 60], radius: 70, color: [215, 165, 135] }] : [],
    });
    const r = processFrame(cv, img, t, DEFAULT_PIPELINE, memory, REFS);
    engine.push({ t, faces: r.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid })) });
    t += 33;
  };
  for (let i = 0; i < 4; i++) frame(false);
  const truth: number[] = [];
  let prev: number | undefined;
  for (let k = 0; k < moves; k++) {
    prev = randomMove(rnd, prev, ALL_MOVES);
    frame(true);
    state = applyMove(state, prev);
    truth.push(prev);
    frame(true);
    for (let i = 0; i < 4; i++) frame(false);
  }
  const decoded = engine.decoder.bestMoves().map((m) => m.move);
  return {
    accuracy: 1 - editDistance(canonical(decoded), canonical(truth)) / truth.length,
    final: statesEqual(engine.decoder.best().state, state),
    observations: engine.decoder.observations,
  };
}

describe("pipeline: synthetic frames → tracker", () => {
  it("上から2面が見える固定カメラで、手で隠れながらの20手を追える", () => {
    const res = [1, 2, 3].map((s) => session(s, [0.8, 4.5, 9], 20));
    process.stdout.write(`pipeline 2-face: ${JSON.stringify(res)}\n`);
    expect(res.filter((r) => r.final).length).toBeGreaterThanOrEqual(2);
    expect(res.reduce((s, r) => s + r.accuracy, 0) / res.length).toBeGreaterThan(0.85);
  });

  it("角から3面が見える場合", () => {
    const res = [4, 5].map((s) => session(s, [5, 5, 8], 20));
    process.stdout.write(`pipeline 3-face: ${JSON.stringify(res)}\n`);
    expect(res.filter((r) => r.final).length).toBeGreaterThanOrEqual(1);
  });
});
