// 精密解析（Refiner）のメモリ: 長いソルブ（ランダムな手を 1 秒 3 手・60fps）を通し、JS のヒープが何に比例して増えるかを見る
//   node --expose-gc ./node_modules/vitest/vitest.mjs run -c vitest.debug.config.ts tests/debug/refineMem.debug.test.ts --silent=false
//   SEC=ソルブの秒数（既定 20）・FPS（既定 60）
import { it } from "vitest";
import { STICKERS, designOf } from "../../src/aruco/design";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, solvedState } from "../../src/cube/model";
import { Refiner } from "../../src/vision/refine";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "../arucoCube";
import { loadTestOpenCv } from "../cv";

it("精密解析のメモリ", async () => {
  const cv = await loadTestOpenCv();
  const sec = Number(process.env.SEC ?? 20);
  const fps = Number(process.env.FPS ?? 60);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const moves: number[] = [];
  for (let i = 0; i < sec * 3; i++) {
    let m: number;
    do m = Math.floor(rnd() * 18);
    while (moves.length && Math.floor(m / 3) === Math.floor(moves[moves.length - 1] / 3));
    moves.push(m);
  }
  const r = new Refiner(cv as never, { state: Array.from(solvedState()), refs: ARUCO_REFS, from: 0, to: Infinity, startHint: 300, pipeline: { ...STICKERS } });
  const gc = (globalThis as { gc?: () => void }).gc;
  const mem = () => {
    gc?.();
    return process.memoryUsage().heapUsed / 1e6;
  };
  const base = mem();
  let st = solvedStickers();
  let done = 0;
  const period = 1000 / 3;
  const turnMs = 150;
  const t0 = performance.now();
  for (let k = 0; ; k++) {
    const t = (k * 1000) / fps;
    if (t > 300 + moves.length * period + 300) break;
    while (done < moves.length && t >= 300 + done * period + turnMs) st = applyMoveStickers(st, moves[done++]);
    const start = 300 + done * period;
    const turning = done < moves.length && t >= start;
    const img = renderArucoCube(cv as never, { width: 1280, height: 960, stickers: st, orient: 0, eye: [2.4 + 0.1 * Math.sin(t / 300), 2.4, 5.5], turn: turning ? { move: moves[done], fraction: (t - start) / turnMs, spread: 0.15 } : undefined, noise: 2, seed: k, scheme: "unique54", design: designOf(STICKERS.arucoDesign!) });
    r.push(img, t);
    if (k % (fps * 2) === 0)
      process.stdout.write(`t ${(t / 1000).toFixed(0)}s heap +${(mem() - base).toFixed(1)}MB frames ${r.frames} obs ${r.engine.observationLog.length} patches ${r.patches.length} (${((performance.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
  const before = mem();
  const res = r.result(null);
  process.stdout.write(`result: heap +${(before - base).toFixed(1)}MB → +${(mem() - base).toFixed(1)}MB moves ${res.moves.length}/${moves.length} ${res.moves.map((m) => MOVE_NAMES[m.move]).join(" ") === moves.map((m) => MOVE_NAMES[m]).join(" ") ? "正しい" : "違う"}\n`);
}, 3600000);
