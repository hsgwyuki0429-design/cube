import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "vitest";
import { initOpenCv } from "../../src/vision/quads";
import { writePng } from "./png";

const DIR = "/home/user/realdata/frames";
it("probe contours", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const name = process.env.NAME ?? "dw-F";
  const meta = JSON.parse(readFileSync(`${DIR}/meta.json`, "utf8"));
  const [w, h] = meta[name];
  const data = new Uint8ClampedArray(readFileSync(`${DIR}/${name}.rgba`));
  const rgba = cv.matFromImageData({ data, width: w, height: h });
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  cv.Canny(gray, edges, 20, 60);
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, kernel);
  // 書き出し
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = edges.data[i];
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  writePng(`${process.env.OUT}/${name}-edges.png`, { data: out, width: w, height: h });
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const approx = new cv.Mat();
  const px = Number(process.env.PX ?? 355), py = Number(process.env.PY ?? 170);
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const r = cv.boundingRect(c);
    if (px < r.x || px > r.x + r.width || py < r.y || py > r.y + r.height) continue;
    const area = cv.contourArea(c);
    const per = cv.arcLength(c, true);
    const rows: number[] = [];
    for (const k of [0.02, 0.035, 0.05, 0.07, 0.09]) {
      cv.approxPolyDP(c, approx, k * per, true);
      rows.push(approx.rows);
    }
    cv.approxPolyDP(c, approx, 0.035 * per, true);
    if (approx.rows === 4) {
      const pts = Array.from({ length: 4 }, (_, k) => [approx.data32S[k * 2], approx.data32S[k * 2 + 1]]);
      let a2 = 0;
      for (let k = 0; k < 4; k++) a2 += pts[k][0] * pts[(k + 1) % 4][1] - pts[(k + 1) % 4][0] * pts[k][1];
      process.stdout.write(`  pts=${JSON.stringify(pts)} polyArea=${Math.abs(a2 / 2)} fill=${(area / Math.abs(a2 / 2)).toFixed(3)}\n`);
    }
    process.stdout.write(`contour ${i} rect=${r.x},${r.y},${r.width}x${r.height} area=${area.toFixed(0)} per=${per.toFixed(0)} approxRows=${rows.join(",")} convex=${cv.isContourConvex(approx)}\n`);
  }
});
