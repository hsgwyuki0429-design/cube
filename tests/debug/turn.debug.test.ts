import { it } from "vitest";
import { moveIndex } from "../../src/cube/model";
import { averageImages, renderCube } from "../render";
import { rng, scrambled } from "../sim";
import { writePng } from "./png";

it("turn frames", () => {
  const state = scrambled(rng(3));
  for (const k of [0, 0.25, 0.5, 0.8]) {
    const img = renderCube({ width: 640, height: 480, state, orient: 0, eye: [0.8, 4.5, 9], turn: { move: moveIndex("R"), fraction: k } });
    writePng(`${process.env.DEBUG_OUT}/turn-${k}.png`, img);
  }
  const blur = averageImages([0.3, 0.4, 0.5].map((k) => renderCube({ width: 640, height: 480, state, orient: 0, eye: [0.8, 4.5, 9], turn: { move: moveIndex("U"), fraction: k } })));
  writePng(`${process.env.DEBUG_OUT}/turn-blur.png`, blur);
});
