// 精密解析の並列化（ParallelFeeder）で、精密に処理するフレーム・全体で検出し直すフレームが増えないか（seqBench の描いた画像を使う）
//   CACHE=… SEED=1 npx vitest run -c vitest.debug.config.ts tests/debug/parFeed.debug.test.ts
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { it } from "vitest";
import { STICKERS } from "../../src/aruco/design";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, solvedState } from "../../src/cube/model";
import { type DetectHint, detectWithHint, detectorFor } from "../../src/vision/arucoFrame";
import { ParallelFeeder } from "../../src/vision/detectPool";
import type { PixelSource } from "../../src/vision/image";
import { StillSkipper } from "../../src/vision/motion";
import { Refiner } from "../../src/vision/refine";
import { loadTestOpenCv } from "../cv";

const VIEWS: Record<number, [number, number]> = { 0: [1280, 720], 1: [1280, 960], 2: [720, 1280], 3: [1280, 720], 4: [1280, 720] };

it("並列の精密解析", async () => {
  const cv = await loadTestOpenCv();
  const seed = Number(process.env.SEED ?? 1);
  const [w, h] = VIEWS[seed % 5];
  const frames: { t: number; img: PixelSource }[] = [];
  for (let t = 0; t < 20000; t += 1000 / 30) {
    const f = `${process.env.CACHE}/normal-30-${seed}-${Math.round(t)}.gz`;
    if (!existsSync(f)) break;
    frames.push({ t, img: { data: new Uint8ClampedArray(gunzipSync(readFileSync(f))), width: w, height: h } as PixelSource });
  }
  const pipeline = { ...STICKERS, arucoRegion: true, arucoTrack: true };
  const make = () => new Refiner(cv as never, { state: Array.from(solvedState()), refs: ARUCO_REFS, from: 0, to: Infinity, startHint: 300, pipeline });
  for (const mode of ["seq", "par"]) {
    const r = make();
    const still = new StillSkipper();
    let detects = 0;
    let fullImage = 0;
    const b = detectorFor(cv as never, "unique54", true, STICKERS.arucoDesign ?? "standard");
    const detect = (img: PixelSource, hint: DetectHint | null) => {
      detects++;
      if (!hint) fullImage++;
      const copy = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
      return new Promise<ReturnType<typeof detectWithHint>>((res) => setTimeout(() => res(detectWithHint(b, copy as never, hint)), 0));
    };
    const feeder = new ParallelFeeder(r, detect, 4);
    const t0 = performance.now();
    for (const f of frames) for (const g of still.next(f.img, f.t)) mode === "seq" ? r.push(g.img, g.t) : await feeder.push(g.img, g.t);
    await feeder.flush();
    const ms = performance.now() - t0;
    const res = r.result(null);
    process.stdout.write(`${mode}: ${frames.length} 枚 → 精密 ${r.frames}・検査で飛ばした ${r.gated}・手がかりなし ${fullImage}/${detects} ${ms.toFixed(0)}ms ${res.moves.map((m) => MOVE_NAMES[m.move]).join(" ")}\n`);
  }
}, 600000);
