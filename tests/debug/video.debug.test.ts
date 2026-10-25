// 実際の動画（フレームを順に）に認識をかけ、正面の面が見つかったフレームの割合と、読めたセルの数を出す。
// 前のフレームの記憶（窓の位置・ブロック分割・面の持ち越し）も実際のアプリと同じく使う。
//   VIDEO_DIR=/path/to/frames（meta.json: name → [w, h, t]） npx vitest run -c vitest.debug.config.ts tests/debug/video.debug.test.ts
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "vitest";
import { NAMED_COLORS, nearestNamed } from "../../src/vision/color";
import { DEFAULT_PIPELINE, type PipelineMemory, processFrame } from "../../src/vision/pipeline";
import { slotPoint } from "../../src/vision/layout";
import { estimatePose, projectSlot } from "../../src/vision/pose";
import { initOpenCv } from "../../src/vision/quads";
import { processTracked } from "../../src/vision/roi";
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
  let ms = 0;
  let multi = 0;
  const line: string[] = [];
  const pd: Record<string, number[]> = {};
  (globalThis as { __pd?: (k: string, v?: number) => void }).__pd = (k, v) => (pd[k] ??= []).push(v ?? 1);
  for (const [name, [w, h, t]] of Object.entries(meta)) {
    const data = new Uint8ClampedArray(readFileSync(`${DIR}/${name}.rgba`));
    const t1 = performance.now();
    const r = process.env.TRACKED ? processTracked(cv, { data, width: w, height: h }, t, DEFAULT_PIPELINE, memory, null, []) : processFrame(cv, { data, width: w, height: h }, t, DEFAULT_PIPELINE, memory, null, []);
    ms += performance.now() - t1;
    frames++;
    const front = r.faces.find((f) => f.slot === 2);
    if (r.faces.length >= 2 && front && !front.held) multi++;
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
      const real = r.faces.filter((f) => !f.held);
      const pose = real.some((f) => f.slot === 2) ? estimatePose(real, w, h) : null;
      if (pose)
        for (const slot of [0, 1, 3, 4]) {
          const pr = projectSlot(pose, slot, w, h);
          if (!pr) continue;
          const g = { H: pr.H, rot: 0 };
          const o = [slotPoint(g, 0, 0), slotPoint(g, 3, 0), slotPoint(g, 3, 3), slotPoint(g, 0, 3)];
          for (let i = 0; i < 4; i++) drawLine(out, o[i], o[(i + 1) % 4], [255, 0, 255]);
          process.stdout.write(`${name} slot ${slot} facing ${pr.facing.toFixed(2)}\n`);
        }
      writePng(`${OUT}/${name}.png`, out);
    }
    line.push(front ? (front.held ? "h" : String(front.valid.filter(Boolean).length)) : ".");
    if (process.env.VERBOSE && front) process.stdout.write(`${name} ${r.faces.map((f) => `${"URFDLB"[f.slot]}${f.held ? "(h)" : ""}:${f.labs.map((l, i) => (f.valid[i] ? NAMED_COLORS[nearestNamed(l)].id : "?")).join("")}`).join(" ")}\n`);
  }
  for (const [k, v] of Object.entries(pd)) {
    const sv = [...v].sort((a, b) => a - b);
    process.stdout.write(`pd ${k}: n=${v.length} p10=${sv[Math.floor(sv.length * 0.1)]?.toFixed(2)} p50=${sv[Math.floor(sv.length * 0.5)]?.toFixed(2)} p90=${sv[Math.floor(sv.length * 0.9)]?.toFixed(2)}\n`);
  }
  process.stdout.write(`frames ${frames} front ${withFront} (${((withFront / frames) * 100).toFixed(0)}%) detected ${realFront} (${((realFront / frames) * 100).toFixed(0)}%) mean valid cells ${(cells / Math.max(1, withFront)).toFixed(1)} ${(ms / frames).toFixed(1)}ms/frame 2+faces ${multi}\n${line.join("")}\n`);
}, 3600000);
