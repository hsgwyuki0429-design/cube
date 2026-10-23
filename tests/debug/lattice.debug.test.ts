import { createRequire } from "node:module";
import { it } from "vitest";
import { findFaces } from "../../src/vision/lattice";
import { findQuads, initOpenCv } from "../../src/vision/quads";
import { renderCube } from "../render";
import { rng, scrambled } from "../sim";

it("lattice", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const state = scrambled(rng(2));
  const img = renderCube({ width: 640, height: 480, state, orient: 0, eye: [5, 5, 8], seed: 2 });
  const mat = cv.matFromImageData(img);
  const quads = findQuads(cv, mat);
  mat.delete();
  const w = (s: string) => process.stdout.write(s + "\n");
  quads.forEach((q, i) => {
    const c = q.corners;
    w(`${i}: c=(${q.center.map((v) => v.toFixed(0))}) area=${q.area.toFixed(0)} corners=${c.map((p) => `(${p[0]},${p[1]})`).join(" ")}`);
  });
  const faces = findFaces(quads);
  for (const f of faces) w(`face found=${f.found} res=${f.residual.toFixed(3)} pitch=${f.pitch.toFixed(1)} cells=${f.cellQuad}`);
});
