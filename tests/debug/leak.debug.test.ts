// OpenCV のメモリの漏れ: ライブの認識と精密解析に同じフレームを何周も通し、OpenCV（wasm）のヒープが増え続けないかを見る。
// Mat の delete 忘れは、1 フレームごとに画像 1 枚ぶん（数 MB）ずつ増えて、スマホではタブごと落ちる。
//   npx vitest run -c vitest.debug.config.ts tests/debug/leak.debug.test.ts --silent=false
import { expect, it } from "vitest";
import { STICKERS, designOf } from "../../src/aruco/design";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { solvedState } from "../../src/cube/model";
import { TrackerEngine } from "../../src/track/engine";
import { ARUCO_OBSERVER } from "../../src/track/observer";
import { frameReading, processFrame } from "../../src/vision/pipeline";
import { Refiner } from "../../src/vision/refine";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "../arucoCube";
import { loadTestOpenCv } from "../cv";
import { parseMoves } from "../../src/cube/model";

it("ライブ・精密解析で OpenCV のヒープが増え続けない", async () => {
  const cv = (await loadTestOpenCv()) as unknown as { HEAP8: Int8Array };
  const truth = parseMoves("R U R' U'");
  const frames: { t: number; img: ReturnType<typeof renderArucoCube> }[] = [];
  let st = solvedStickers();
  let done = 0;
  for (let t = 0; t < 2000; t += 1000 / 30) {
    const start = 200 + done * 400;
    while (done < truth.length && t >= start + 170) st = applyMoveStickers(st, truth[done++]);
    const s2 = 200 + done * 400;
    const turning = done < truth.length && t >= s2;
    frames.push({ t, img: renderArucoCube(cv as never, { width: 1280, height: 960, stickers: st, orient: 0, eye: [2.4 + 0.1 * Math.sin(t / 300), 2.4, 5.5], turn: turning ? { move: truth[done], fraction: (t - s2) / 170, spread: 0.15 } : undefined, noise: 2, seed: Math.round(t), scheme: "unique54", design: designOf(STICKERS.arucoDesign!) }) });
  }
  const heap = () => cv.HEAP8.length / 1e6;
  const runs: Record<string, number[]> = { live: [], refine: [] };
  for (let lap = 0; lap < 6; lap++) {
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS, { observer: ARUCO_OBSERVER });
    const memory = {};
    for (const f of frames) engine.push(frameReading(f.t, processFrame(cv as never, f.img, f.t + lap * 3000, { ...STICKERS, arucoRegion: true, arucoTrack: true, arucoTurn: false }, memory)));
    runs.live.push(heap());
  }
  for (let lap = 0; lap < 6; lap++) {
    const r = new Refiner(cv as never, { state: Array.from(solvedState()), refs: ARUCO_REFS, from: 0, to: Infinity, startHint: 200, pipeline: { ...STICKERS } });
    for (const f of frames) r.push(f.img, f.t);
    r.result(null);
    runs.refine.push(heap());
  }
  process.stdout.write(`heap MB live ${runs.live.map((x) => x.toFixed(0)).join(" ")} / refine ${runs.refine.map((x) => x.toFixed(0)).join(" ")}\n`);
  expect(runs.live[5]).toBeLessThanOrEqual(runs.live[1] + 1);
  expect(runs.refine[5]).toBeLessThanOrEqual(runs.refine[1] + 1);
}, 600000);
