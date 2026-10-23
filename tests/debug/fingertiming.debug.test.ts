import { createRequire } from "node:module";
import { it } from "vitest";
import { OPPOSITE, moveFace } from "../../src/cube/model";
import { cellInLayer } from "../../src/track/timing";
import { layerMotion, refineEnd } from "../../src/vision/fineTiming";
import { initOpenCv } from "../../src/vision/quads";
import { simulate } from "../speed";

it("finger timing", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const moves = Number(process.env.MOVES ?? 4);
  const { writePng, drawLine } = await import("./png");
  const { processFrame, DEFAULT_PIPELINE } = await import("../../src/vision/pipeline");
  const { slotPoint } = await import("../../src/vision/layout");
  const { REFS } = await import("../speed");
  const mem = { last: null };
  const r = simulate(cv, {
    seed: Number(process.env.SEED ?? 1), moves, tps: Number(process.env.TPS ?? 4), fps: Number(process.env.FPS ?? 30), exposureMs: Number(process.env.EXP ?? 12), solveTo: true, refine: true,
    scene: JSON.parse(process.env.SCENE ?? '{"harshness":"real","fingers":"heavy","maskQuality":0.5}'),
    onFrame: (t, img, hands) => {
      const pr = processFrame(cv, img, t, DEFAULT_PIPELINE, mem, REFS, hands);
      if (!process.env.OUT || ![400, 433, 467].some((x) => Math.abs(x - t) < 5)) return;
      const out = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
      for (const hull of hands) for (let k = 0; k < hull.length; k++) drawLine(out, hull[k], hull[(k + 1) % hull.length], [255, 255, 0]);
      for (const q of pr.quads) for (let k = 0; k < 4; k++) drawLine(out, q[k] as [number, number], q[(k + 1) % 4] as [number, number], [255, 0, 255]);
      for (const f of pr.faces) {
        const o = [slotPoint(f, 0, 0), slotPoint(f, 3, 0), slotPoint(f, 3, 3), slotPoint(f, 0, 3)];
        for (let k = 0; k < 4; k++) drawLine(out, o[k], o[(k + 1) % 4], f.slot === 2 ? [0, 255, 255] : [0, 120, 255]);
        for (let i = 1; i < 3; i++) {
          drawLine(out, slotPoint(f, i, 0), slotPoint(f, i, 3), [0, 200, 200]);
          drawLine(out, slotPoint(f, 0, i), slotPoint(f, 3, i), [0, 200, 200]);
        }
      }
      writePng(`${process.env.OUT}/ft-${Math.round(t)}.png`, out);
    },
  });
  const ref = r.refiner!;
  const f = r.refined!;
  const eng = ref.engine;
  const raw = f.raw!;
  const first = raw[0];
  const last = raw[raw.length - 1];
  process.stdout.write(`truth ${r.startTruth}..${r.endTruth} truthMoves=${r.truth} decoded=${raw.map((m) => m.move)} method=${f.method}\n`);
  process.stdout.write(`final start=${f.start} end=${f.end}\n`);
  process.stdout.write(`first raw t0=${first.t0} t=${first.t} start=${first.start} | last t0=${last.t0} t=${last.t} end=${last.end}\n`);
  const dm = eng.decoder.bestMoves();
  process.stdout.write(`live-ish engine first timing ${JSON.stringify(eng.timing(dm[0]))}\n`);
  const opp = { move: OPPOSITE[moveFace(first.move)] * 3, t0: first.t0, t: first.t, orient: dm[0].orient };
  process.stdout.write(`opposite timing ${JSON.stringify(eng.timing(opp))}\n`);
  // 開始付近のフレームごとの様子
  const face = moveFace(first.move);
  const sface = process.env.OPP ? OPPOSITE[face] : face;
  for (const fr of eng.frames.filter((x) => x.t > r.startTruth - 250 && x.t < r.startTruth + 150)) {
    const cells: string[] = [];
    for (const fc of fr.faces)
      for (let c = 0; c < 9; c++) if (cellInLayer(dm[0].orient, fc.slot, c, sface)) cells.push(`${fc.slot}.${c}:${fc.masked?.[c] ? "M" : fc.valid[c] ? fc.labs[c].map(Math.round).join("/") + "~" + Math.round(fc.spread?.[c] ?? -1) : "x"}`);
    process.stdout.write(`  F ${fr.t.toFixed(0)} ${cells.join(" ")}\n`);
  }
  const P = ref.patches;
  const base = [...P].reverse().find((p) => p.t <= r.startTruth - 100)!;
  for (const p of P.filter((x) => x.t > r.startTruth - 250 && x.t < r.startTruth + 150)) process.stdout.write(`  P ${p.t.toFixed(0)} motion=${layerMotion(base, p, 0, face, eng.colors.refs)?.toFixed(1)}\n`);
  // 終わり付近
  const lf = moveFace(last.move);
  const lm = { move: last.move, t0: last.t0, t: last.t, orient: dm[dm.length - 1]?.orient ?? 0 };
  process.stdout.write(`refineEnd=${refineEnd(P, lm, last.end, eng.colors.refs)} orient=${lm.orient}\n`);
  const lo = { ...lm, move: OPPOSITE[lf] * 3 };
  const lot = eng.timing(lo);
  process.stdout.write(`last opposite timing ${JSON.stringify(lot)} refineEnd=${lot ? refineEnd(P, lo, lot.end, eng.colors.refs) : "-"}\n`);
  const endBase = P.find((p) => p.t >= r.endTruth + 80);
  for (const fr of eng.frames.filter((x) => x.t > r.endTruth - 300 && x.t < r.endTruth + 250)) {
    const cells: string[] = [];
    for (const fc of fr.faces)
      for (let c = 0; c < 9; c++) if (cellInLayer(lm.orient, fc.slot, c, process.env.OPP ? OPPOSITE[lf] : lf)) cells.push(`${fc.slot}.${c}:${fc.masked?.[c] ? "M" : fc.valid[c] ? fc.labs[c].map(Math.round).join("/") + "~" + Math.round(fc.spread?.[c] ?? -1) : "x"}`);
    const p = P.find((x) => Math.abs(x.t - fr.t) < 1);
    process.stdout.write(`  E ${fr.t.toFixed(0)} motion=${endBase && p ? layerMotion(endBase, p, lm.orient, process.env.OPP ? OPPOSITE[lf] : lf, eng.colors.refs)?.toFixed(1) : "-"} ${cells.join(" ")}\n`);
  }
});
