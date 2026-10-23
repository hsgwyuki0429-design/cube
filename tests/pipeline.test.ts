import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMove, applyMoves, invertMoves, isSolved, solvedState, statesEqual, type Vec3 } from "../src/cube/model";
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

function session(seed: number, eye: Vec3, moves: number, orient = 0, opts: { gap?: number; seam?: [number, number, number]; solveTo?: boolean } = {}) {
  const rnd = rng(seed);
  // solveTo: 完成の数手前から始めて、最後は完成させる（ステッカーレスの完成面を検出できるか）
  const ending = opts.solveTo ? Array.from({ length: moves }, (_, i) => i).reduce<number[]>((acc) => [...acc, randomMove(rnd, acc[acc.length - 1], ALL_MOVES)], []) : [];
  let state = opts.solveTo ? applyMoves(solvedState(), invertMoves(ending)) : scrambled(rnd);
  const engine = new TrackerEngine(state, REFS, process.env.ENGINE_OPTS ? JSON.parse(process.env.ENGINE_OPTS) : {});
  const memory = { last: null };
  let t = 0;
  let frameSeed = seed * 1000;
  const frame = (occluded: boolean) => {
    const oc = { center: [300 + rnd() * 60, 250 + rnd() * 60] as [number, number], radius: 70, color: [215, 165, 135] as [number, number, number] };
    // アプリでは指は MediaPipe で手として隠れる（同じようにマスクとして渡す）
    const hands = occluded ? [Array.from({ length: 12 }, (_, i) => [oc.center[0] + 80 * Math.cos((i * Math.PI) / 6), oc.center[1] + 80 * Math.sin((i * Math.PI) / 6)] as [number, number])] : [];
    const img = renderCube({
      width: 640,
      height: 480,
      state,
      orient,
      eye,
      seed: frameSeed++,
      occluders: occluded ? [oc] : [],
      gap: opts.gap,
      seam: opts.seam,
    });
    const r = processFrame(cv, img, t, DEFAULT_PIPELINE, memory, REFS, process.env.NO_MASK ? [] : hands);
    engine.push({ t, faces: r.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid })) });
    t += 33;
  };
  for (let i = 0; i < 4; i++) frame(false);
  const truth: number[] = [];
  let prev: number | undefined;
  for (let k = 0; k < moves; k++) {
    prev = opts.solveTo ? ending[k] : randomMove(rnd, prev, ALL_MOVES);
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
    solved: isSolved(engine.decoder.best().state),
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

  it("ステッカーレス（細い溝あり）で、完成まで追えて完成を検出する", () => {
    const res = [7, 8, 9].map((s) => session(s, [0.8, 4.5, 9], 10, 0, { gap: 0.012, seam: [45, 45, 45], solveTo: true }));
    process.stdout.write(`pipeline stickerless(seam): ${JSON.stringify(res)}\n`);
    expect(res.filter((r) => r.solved && r.final).length).toBeGreaterThanOrEqual(2);
  });

  it("ステッカーレス（溝が全く見えない最悪条件）でも一部は追える", () => {
    const res = [7, 8, 9].map((s) => session(s, [0.8, 4.5, 9], 10, 0, { gap: 0, solveTo: true }));
    process.stdout.write(`pipeline stickerless(noseam): ${JSON.stringify(res)}\n`);
    expect(res.filter((r) => r.solved && r.final).length).toBeGreaterThanOrEqual(1);
    expect(res.reduce((s, r) => s + r.accuracy, 0) / res.length).toBeGreaterThan(0.75);
  });
});
