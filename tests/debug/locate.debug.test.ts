import { createRequire } from "node:module";
import { it } from "vitest";
import { findFaces } from "../../src/vision/lattice";
import { stickerScore } from "../../src/vision/stickerness";
import { rgbToLab } from "../../src/vision/color";
import { layoutFaces, slotPoint } from "../../src/vision/layout";
import { findQuads, initOpenCv } from "../../src/vision/quads";
import { renderCube } from "../render";
import { rng, scrambled } from "../sim";
import { drawLine, writePng } from "./png";

const OUT = process.env.DEBUG_OUT ?? "/tmp";
it("debug", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const cases: [string, [number, number, number], object][] = [
    ["top", [0.6, 4.5, 9], {}],
    ["corner", [5, 5, 8], {}],
    ["lowleft", [-5, -4, 8], {}],
    ["roll", [0, 3, 10], { up: [0.35, 1, 0] }],
    ["orient", [0.5, 4, 9], { orient: 7 }],
    ["corner4", [5, 5, 8], { seed: 4 }],
  ];
  for (const [name, eye, extra] of cases) {
    const state = scrambled(rng((extra as { seed?: number }).seed ?? 2));
    const img = renderCube({ width: 640, height: 480, state, orient: 0, eye, seed: 2, ...extra });
    const mat = cv.matFromImageData(img);
    const quads = findQuads(cv, mat);
    mat.delete();
    const scorer = (pt: [number, number]) => {
      const x = Math.round(pt[0]);
      const y = Math.round(pt[1]);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) return -1;
      const k = (y * img.width + x) * 4;
      return stickerScore(rgbToLab(img.data[k], img.data[k + 1], img.data[k + 2]));
    };
    const faces = findFaces(quads, {}, scorer);
    const placed = layoutFaces(faces);
    process.stdout.write(`${name} quads ${quads.length} faces ${faces.map((f) => `${f.found}/${f.residual.toFixed(2)}`).join(" ")} slots ${placed.map((p) => p.slot)}\n`);
    for (const q of quads) for (let k = 0; k < 4; k++) drawLine(img, q.corners[k], q.corners[(k + 1) % 4], [255, 0, 255]);
    for (const p of placed) {
      for (let i = 0; i <= 3; i++) {
        drawLine(img, slotPoint(p, 0, i), slotPoint(p, 3, i), [0, 255, 255]);
        drawLine(img, slotPoint(p, i, 0), slotPoint(p, i, 3), [0, 255, 255]);
      }
      drawLine(img, slotPoint(p, 0.2, 0.2), slotPoint(p, 1.2, 0.2), [255, 255, 0]);
    }
    writePng(`${OUT}/${name}.png`, img);
  }
});
