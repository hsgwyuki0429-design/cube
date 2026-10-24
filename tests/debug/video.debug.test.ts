// 実際の動画（フレームを順に）に認識をかけ、正面の面が見つかったフレームの割合と、読めたセルの数を出す。
// 前のフレームの記憶（窓の位置・ブロック分割・面の持ち越し）も実際のアプリと同じく使う。
//   VIDEO_DIR=/path/to/frames（meta.json: name → [w, h, t]） npx vitest run -c vitest.debug.config.ts tests/debug/video.debug.test.ts
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "vitest";
import { NAMED_COLORS, nearestNamed } from "../../src/vision/color";
import { DEFAULT_PIPELINE, type PipelineMemory, processFrame } from "../../src/vision/pipeline";
import { slotPoint } from "../../src/vision/layout";
import { initOpenCv } from "../../src/vision/quads";
import { drawLine, writePng } from "./png";

const DIR = process.env.VIDEO_DIR ?? "";

it("video frames", async () => {
  if (!existsSync(`${DIR}/meta.json`)) return;
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const meta = JSON.parse(readFileSync(`${DIR}/meta.json`, "utf8")) as Record<string, [number, number, number]>;
  const memory: { last: PipelineMemory | null } = { last: null };
  let withFront = 0;
  let realFront = 0;
  let cells = 0;
  let frames = 0;
  const line: string[] = [];
  for (const [name, [w, h, t]] of Object.entries(meta)) {
    const data = new Uint8ClampedArray(readFileSync(`${DIR}/${name}.rgba`));
    const r = processFrame(cv, { data, width: w, height: h }, t, DEFAULT_PIPELINE, memory, null, []);
    frames++;
    const front = r.faces.find((f) => f.slot === 2);
    if (front) {
      withFront++;
      if (!front.held) realFront++;
      cells += front.valid.filter(Boolean).length;
    }
    const OUT = process.env.VIDEO_OUT;
    if (OUT && Number(name.slice(1)) % Number(process.env.EVERY ?? 10) === 0) {
      const out = { data: new Uint8ClampedArray(data), width: w, height: h };
      for (const f of r.faces) {
        const o = [slotPoint(f, 0, 0), slotPoint(f, 3, 0), slotPoint(f, 3, 3), slotPoint(f, 0, 3)];
        for (let i = 0; i < 4; i++) drawLine(out, o[i], o[(i + 1) % 4], f.slot === 2 ? (f.held ? [255, 255, 0] : [0, 255, 255]) : [0, 120, 255]);
        for (let i = 1; i < 3; i++) {
          drawLine(out, slotPoint(f, i, 0), slotPoint(f, i, 3), [0, 200, 200]);
          drawLine(out, slotPoint(f, 0, i), slotPoint(f, 3, i), [0, 200, 200]);
        }
      }
      writePng(`${OUT}/${name}.png`, out);
    }
    line.push(front ? (front.held ? "h" : String(front.valid.filter(Boolean).length)) : ".");
    if (process.env.VERBOSE && front) process.stdout.write(`${name} ${r.faces.map((f) => `${"URFDLB"[f.slot]}${f.held ? "(h)" : ""}:${f.labs.map((l, i) => (f.valid[i] ? NAMED_COLORS[nearestNamed(l)].id : "?")).join("")}`).join(" ")}\n`);
  }
  process.stdout.write(`frames ${frames} front ${withFront} (${((withFront / frames) * 100).toFixed(0)}%) detected ${realFront} (${((realFront / frames) * 100).toFixed(0)}%) mean valid cells ${(cells / Math.max(1, withFront)).toFixed(1)}\n${line.join("")}\n`);
}, 3600000);
