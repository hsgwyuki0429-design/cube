import { createRequire } from "node:module";
import { it } from "vitest";
import { MOVE_NAMES, VIEW, applyMove, applyMoves, invertMoves, solvedState } from "../../src/cube/model";
import { rgbToLab, type Lab } from "../../src/vision/color";
import { DEFAULT_PIPELINE, processFrame } from "../../src/vision/pipeline";
import { initOpenCv } from "../../src/vision/quads";
import { TrackerEngine } from "../../src/track/engine";
import { PALETTE, renderCube } from "../render";
import { ALL_MOVES, randomMove, rng } from "../sim";
import { writePng, drawLine } from "./png";
import { slotPoint } from "../../src/vision/layout";

const REFS: Lab[] = PALETTE.map(([r, g, b]) => rgbToLab(r * 0.85, g * 0.85, b * 0.85));
it("stickerless session", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const rnd = rng(7);
  const ending: number[] = [];
  for (let i = 0; i < 10; i++) ending.push(randomMove(rnd, ending[ending.length - 1], ALL_MOVES));
  let state = applyMoves(solvedState(), invertMoves(ending));
  const engine = new TrackerEngine(state, REFS);
  const memory = { last: null };
  let t = 0;
  const w = (s: string) => process.stdout.write(s + "\n");
  const frame = (label: string, dump = false, occluded = false) => {
    const img = renderCube({ width: 640, height: 480, state, orient: 0, eye: [0.8, 4.5, 9], seed: t, gap: 0, occluders: occluded ? [{ center: [300 + rnd() * 60, 250 + rnd() * 60], radius: 70, color: [215, 165, 135] }] : [] });
    const r = processFrame(cv, img, t, DEFAULT_PIPELINE, memory, REFS);
    const u = engine.push({ t, faces: r.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid })) });
    const truthLabels = (slot: number) => Array.from({ length: 9 }, (_, c) => state[VIEW[(0 * 6 + slot) * 9 + c]]).join("");
    const read = r.faces.map((f) => `${f.slot}${f.held ? "h" : ""}:${f.found}:${f.labs.map((l, i) => (f.valid[i] ? engine.colors.classify(l).label : "?")).join("")}/${truthLabels(f.slot)}`).join(" ");
    w(`${label.padEnd(8)} q=${String(r.quads.length).padStart(2)} ${read}${u ? `  OBS -> ${u.moves.map((m) => MOVE_NAMES[m.move]).join(" ")} cost=${u.obsCost.toFixed(2)} ${u.status}` : ""}`);
    if (dump) {
      for (const q of r.quads) for (let k = 0; k < 4; k++) drawLine(img, q[k], q[(k + 1) % 4], [255, 0, 255]);
      for (const p of r.faces) for (let i = 0; i <= 3; i++) { drawLine(img, slotPoint(p, 0, i), slotPoint(p, 3, i), [0, 255, 255]); drawLine(img, slotPoint(p, i, 0), slotPoint(p, i, 3), [0, 255, 255]); }
      writePng(`${process.env.DEBUG_OUT}/sl-${label}.png`, img);
    }
    t += 33;
  };
  for (let i = 0; i < 4; i++) frame("init", i === 3);
  for (let k = 0; k < ending.length; k++) {
    frame(`occ${k}`, false, true);
    state = applyMove(state, ending[k]);
    frame(`occ${k}`, false, true);
    for (let i = 0; i < 4; i++) frame(`m${k}:${MOVE_NAMES[ending[k]]}`, i === 3 && k >= 7);
  }
});
