// リアルタイムの追跡がどこで正解からずれるか（実物らしい合成映像で）
import { createRequire } from "node:module";
import { it } from "vitest";
import { MOVE_NAMES } from "../../src/cube/model";
import { initOpenCv } from "../../src/vision/quads";
import { simulate } from "../speed";

it("live diag", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const c = JSON.parse(process.env.CFG ?? '{"tps":4,"fps":30,"exp":12,"every":2,"tracked":true,"seed":2,"scene":{"harshness":"real","fingers":"heavy","maskQuality":0.5}}');
  const pd: Record<string, number[]> = {};
  (globalThis as { __pd?: (k: string, v?: number) => void }).__pd = (k, v) => (pd[k] ??= []).push(v ?? 1);
  const r = simulate(cv, { seed: c.seed, moves: c.moves ?? 16, tps: c.tps, fps: c.fps, exposureMs: c.exp, solveTo: true, every: c.every, scene: c.scene, tracked: c.tracked, engine: { keepObservations: true } as never });
  const period = 1000 / c.tps;
  process.stdout.write(`truth: ${r.truth.map((m, i) => `${MOVE_NAMES[m]}@${Math.round(600 + i * period)}`).join(" ")}\n`);
  process.stdout.write(`live : ${r.decoded.map((m) => `${MOVE_NAMES[m.move]}${m.inferred ? "?" : ""}@${Math.round(m.t)}`).join(" ")}\n`);
  process.stdout.write(`obs  : ${r.engine.observationLog.map((o) => `${Math.round(o.t)}[${o.faces.map((f) => `${"URFDLB"[f.slot]}${f.labels.filter((l) => l >= 0).length}`).join("")}]`).join(" ")}\n`);
  for (const [k, v] of Object.entries(pd)) {
    const sv = [...v].sort((a, b) => a - b);
    process.stdout.write(`pd ${k}: n=${v.length} p10=${sv[Math.floor(sv.length * 0.1)]?.toFixed(2)} p50=${sv[Math.floor(sv.length * 0.5)]?.toFixed(2)} p90=${sv[Math.floor(sv.length * 0.9)]?.toFixed(2)}\n`);
  }
  process.stdout.write(`acc ${(r.accuracy * 100).toFixed(0)}% status ${r.engine.decoder.status} recoveries ${r.engine.decoder.recoveries}\n`);
}, 600000);
