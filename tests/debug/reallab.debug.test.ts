import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { it } from "vitest";
import { F } from "../../src/cube/model";
import { assignBalanced } from "../../src/scan/assign";
import { DEFAULT_PIPELINE, processFrame } from "../../src/vision/pipeline";
import { initOpenCv } from "../../src/vision/quads";

it("lab dump", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const DIR = new URL("../fixtures/real/", import.meta.url);
  const truth = JSON.parse(readFileSync(new URL("dw-truth.json", DIR), "utf8"));
  const centers = [4, 13, 22, 31, 40, 49].map((i) => truth.rgb[i]);
  const tl = assignBalanced(truth.rgb.map((c: number[]) => centers.map((k: number[]) => Math.hypot(c[0] - k[0], c[1] - k[1], c[2] - k[2]))));
  const [w, h] = truth.size;
  for (const [i, side] of ["U", "R", "F", "D", "L", "B"].entries()) {
    const rgb = inflateSync(readFileSync(new URL(`dw-${side}.rgb.z`, DIR)));
    const data = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      data[p * 4] = rgb[p * 3];
      data[p * 4 + 1] = rgb[p * 3 + 1];
      data[p * 4 + 2] = rgb[p * 3 + 2];
      data[p * 4 + 3] = 255;
    }
    const r = processFrame(cv, { data, width: w, height: h }, 0, DEFAULT_PIPELINE, { last: null }, null, []);
    const f = r.faces.find((x) => x.slot === F)!;
    const want = [...tl.slice(i * 9, i * 9 + 9)].sort().join("");
    process.stdout.write(`${side} truth-multiset=${want} labs=${f.labs.map((l) => l.map(Math.round).join("/")).join(" ")}\n`);
  }
});

it("assemble diag", async () => {
  const { assembleScan } = await import("../../src/scan/scan");
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const DIR = new URL("../fixtures/real/", import.meta.url);
  const truth = JSON.parse(readFileSync(new URL("dw-truth.json", DIR), "utf8"));
  const centers = [4, 13, 22, 31, 40, 49].map((i) => truth.rgb[i]);
  const tl = assignBalanced(truth.rgb.map((c: number[]) => centers.map((k: number[]) => Math.hypot(c[0] - k[0], c[1] - k[1], c[2] - k[2]))));
  const [w, h] = truth.size;
  const scanned = ["U", "R", "F", "D", "L", "B"].map((side, i) => {
    const rgb = inflateSync(readFileSync(new URL(`dw-${side}.rgb.z`, DIR)));
    const data = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      data[p * 4] = rgb[p * 3];
      data[p * 4 + 1] = rgb[p * 3 + 1];
      data[p * 4 + 2] = rgb[p * 3 + 2];
      data[p * 4 + 3] = 255;
    }
    const r = processFrame(cv, { data, width: w, height: h }, 0, DEFAULT_PIPELINE, { last: null }, null, []);
    return { face: i, labs: r.faces.find((x) => x.slot === F)!.labs };
  });
  const res = assembleScan(scanned, "standard");
  process.stdout.write(`problems=${JSON.stringify(res.problems)} rotations=${res.rotations} names=${res.names} uncertain=${res.uncertain}\n`);
  for (let i = 0; i < 6; i++) process.stdout.write(`face ${i}: ours=${res.cellLabels.slice(i * 9, i * 9 + 9).join("")} truthSorted=${[...tl.slice(i * 9, i * 9 + 9)].sort().join("")} oursSorted=${[...res.cellLabels.slice(i * 9, i * 9 + 9)].sort().join("")}\n`);
});
