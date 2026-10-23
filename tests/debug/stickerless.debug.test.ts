import { createRequire } from "node:module";
import { it } from "vitest";
import { solvedState, applyMoves } from "../../src/cube/model";
import { DEFAULT_PIPELINE, processFrame } from "../../src/vision/pipeline";
import { initOpenCv } from "../../src/vision/quads";
import { renderCube } from "../render";
import { rng, scrambled } from "../sim";

it("stickerless", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const states = { solved: solvedState(), oneMove: applyMoves(solvedState(), "R"), scrambled: scrambled(rng(3)) };
  for (const [gapName, gap, seam] of [["stickered", 0.07, undefined], ["seam", 0.015, [40, 40, 40]], ["noseam", 0.0, undefined]] as const) {
    for (const [sn, st] of Object.entries(states)) {
      const img = renderCube({ width: 640, height: 480, state: st, orient: 0, eye: [0.6, 4.5, 9], seed: 5, gap, seam: seam as any });
      // 直前に崩れた状態を見てピッチを覚えている、という状況を再現
      const memory = { last: null };
      processFrame(cv, renderCube({ width: 640, height: 480, state: states.scrambled, orient: 0, eye: [0.6, 4.5, 9], seed: 4, gap, seam: seam as any }), 0, DEFAULT_PIPELINE, memory, null);
      const r = processFrame(cv, img, 100, DEFAULT_PIPELINE, memory, null);
      const cold = processFrame(cv, img, 0, DEFAULT_PIPELINE, { last: null }, null);
      process.stdout.write(`${gapName.padEnd(9)} ${sn.padEnd(9)} quads=${String(r.quads.length).padStart(2)} faces=${r.faces.map((f) => `${f.slot}:${f.found}`).join(",")} cold=${cold.faces.map((f) => `${f.slot}:${f.found}`).join(",")}\n`);
    }
  }
});
