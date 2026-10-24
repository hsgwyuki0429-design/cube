import { createRequire } from "node:module";
import { it } from "vitest";
import { F, R, U, cubeFaceAt } from "../../src/cube/model";
import { FaceCapture } from "../../src/scan/scan";
import { slotPoint } from "../../src/vision/layout";
import { DEFAULT_PIPELINE, processFrame } from "../../src/vision/pipeline";
import { initOpenCv } from "../../src/vision/quads";
import { type SceneOptions, scene } from "../realism";
import { axisAngle, renderCube } from "../render";
import { rng, scrambled } from "../sim";
import { drawLine, writePng } from "./png";

it("harsh scan frames", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const so: SceneOptions = JSON.parse(process.env.SCENE ?? '{"harshness":"harsh","fingers":"heavy","maskQuality":0.7,"backdrop":"plaid"}');
  const face = Number(process.env.FACE ?? R);
  const orient = Array.from({ length: 24 }, (_, o) => o).find((o) => cubeFaceAt(o, F) === face && cubeFaceAt(o, U) === U)!;
  const state = scrambled(rng(90));
  const rnd = rng(22);
  const memory = { last: null };
  const cap = new FaceCapture();
  let t = 0;
  const lines: string[] = [];
  for (let i = 0; i < 60; i++) {
    const rotation = axisAngle([Math.sin(t / 500), 1, Math.cos(t / 700)].map((v, _, a) => v / Math.hypot(...a)) as [number, number, number], 0.12 * Math.sin(t / 380));
    const base = { width: 640, height: 480, orient, eye: [0.3, 2.2, 9] as [number, number, number], rotation, offset: [0.15 * Math.sin(t / 450), 0.1 * Math.cos(t / 520), 0] as [number, number, number] };
    const sc = scene(base, t, so, rnd);
    const img = renderCube({ ...base, state, seed: i, realism: sc.realism });
    (globalThis as { __cvDebug?: (m: unknown) => void }).__cvDebug = i < Number(process.env.DBG ?? 0) ? (m) => lines.push(`  judge ${JSON.stringify(m)}`) : undefined;
    const r = processFrame(cv, img, t, DEFAULT_PIPELINE, memory, null, sc.hands);
    t += 33;
    const front = r.faces.find((f) => f.slot === F);
    const p = cap.push(front ? { labs: front.labs, valid: front.valid.map((v, k) => v && !front.masked[k]) } : null, []);
    lines.push(`${i}: quads=${r.quads.length} faces=${r.faces.map((f) => f.slot).join(",")} front=${front ? front.valid.map((v, k) => (front.masked[k] ? "m" : v ? "o" : "x")).join("") : "-"} progress=${p.progress.toFixed(2)} ${p.reason ?? "CAPTURED"} covered=${p.covered?.map((c) => (c ? 1 : 0)).join("") ?? ""}`);
    if (i % 10 === 0 && process.env.OUT) {
      const out = { data: new Uint8ClampedArray(img.data), width: 640, height: 480 };
      for (const q of r.quads) for (let k = 0; k < 4; k++) drawLine(out, q[k] as [number, number], q[(k + 1) % 4] as [number, number], [255, 0, 255]);
      for (const f of r.faces) {
        const o = [slotPoint(f, 0, 0), slotPoint(f, 3, 0), slotPoint(f, 3, 3), slotPoint(f, 0, 3)];
        for (let k = 0; k < 4; k++) drawLine(out, o[k], o[(k + 1) % 4], [0, 255, 255]);
      }
      for (const hull of sc.hands) for (let k = 0; k < hull.length; k++) drawLine(out, hull[k], hull[(k + 1) % hull.length], [255, 255, 0]);
      writePng(`${process.env.OUT}/harsh-${i}.png`, out);
    }
    if (p.labs) break;
  }
  process.stdout.write(lines.join("\n") + "\n");
});
