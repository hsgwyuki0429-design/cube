import { createRequire } from "node:module";
import { it } from "vitest";
import { initOpenCv } from "../../src/vision/quads";
import { renderCube } from "../render";
import { rng, scrambled } from "../sim";

it("contours", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const state = scrambled(rng(4));
  const img = renderCube({ width: 640, height: 480, state, orient: 0, eye: [5, 5, 8], seed: 4 });
  const rgba = cv.matFromImageData(img);
  const gray = new cv.Mat(); const edges = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  cv.Canny(gray, edges, 20, 60);
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, kernel);
  const contours = new cv.MatVector(); const hier = new cv.Mat();
  cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const approx = new cv.Mat();
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const r = cv.boundingRect(c);
    if (r.y < 200 && r.y > 90 && r.x > 160 && r.x < 470 && r.width > 15) {
      const per = cv.arcLength(c, true);
      const res = [];
      for (const k of [0.02, 0.035, 0.05, 0.07, 0.09]) { cv.approxPolyDP(c, approx, k * per, true); res.push(approx.rows); }
      const pts = []; for (let k = 0; k < approx.rows; k++) pts.push(`(${approx.data32S[k*2]},${approx.data32S[k*2+1]})`);
      process.stdout.write(`rect ${r.x},${r.y} ${r.width}x${r.height} area ${cv.contourArea(c).toFixed(0)} approx ${res} pts ${pts.join("")}\n`);
    }
  }
  const out = new Uint8ClampedArray(640 * 480 * 4);
  for (let i = 0; i < 640 * 480; i++) { out[i*4] = out[i*4+1] = out[i*4+2] = edges.data[i]; out[i*4+3] = 255; }
  const { writePng } = await import("./png");
  writePng(`${process.env.DEBUG_OUT}/edges.png`, { data: out, width: 640, height: 480 });
});
