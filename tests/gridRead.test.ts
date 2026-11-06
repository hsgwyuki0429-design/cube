// 格子で読む（src/aruco/gridRead.ts）と、ライブの面の格子で追う認識（src/vision/arucoFrame.ts の liveMarkers）
import { beforeAll, describe, expect, it } from "vitest";
import { cellH } from "../src/aruco/cube";
import { STICKERS, designOf } from "../src/aruco/design";
import { gridReadCell } from "../src/aruco/gridRead";
import { ARUCO_REFS } from "../src/aruco/palette";
import { MOVE_NAMES, type Vec3, parseMoves, solvedState } from "../src/cube/model";
import { TrackerEngine } from "../src/track/engine";
import { simplifyMoves } from "../src/track/merge";
import { ARUCO_OBSERVER } from "../src/track/observer";
import { liveStats } from "../src/vision/arucoFrame";
import type { CV } from "../src/vision/image";
import { frameReading, processFrame } from "../src/vision/pipeline";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "./arucoCube";
import { loadTestOpenCv } from "./cv";

let cv: CV;
beforeAll(async () => {
  cv = await loadTestOpenCv();
}, 120000);

const SIZE = { width: 1280, height: 960 };
const EYE: Vec3 = [2.4, 2.4, 5.5];
const design = designOf(STICKERS.arucoDesign);

describe("格子で読む", () => {
  it("検出で読めたマスを格子で読むと同じ ID になる（読み違えない）", () => {
    let st = solvedStickers();
    for (const m of parseMoves("R U F' L2 D B'")) st = applyMoveStickers(st, m);
    const img = renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: EYE, noise: 2.5, seed: 3, scheme: "unique54", design });
    const r = processFrame(cv, img, 0, { ...STICKERS, arucoThorough: true, arucoReread: 0, arucoColorFill: false, arucoIdTrack: false }, {});
    let same = 0;
    let known = 0;
    for (const f of r.faces) {
      if (f.held || !f.marker) continue;
      for (let cell = 0; cell < 9; cell++) {
        const id = f.ids?.[cell] ?? -1;
        if (id < 0) continue;
        known++;
        const g = gridReadCell(img, cellH(f, cell), cell, "unique54", design, f.marker / 0.84);
        if (!g) continue;
        expect(g.sticker).toBe(id);
        same++;
      }
    }
    expect(known).toBeGreaterThan(20);
    expect(same / known).toBeGreaterThan(0.6);
  }, 120000);

  it("回している途中の層のマスは読まない（回していない面の格子では向きが合わない）", () => {
    const st = solvedStickers();
    const memory = {};
    const cfg = { ...STICKERS, arucoThorough: true, arucoReread: 0, arucoColorFill: false, arucoIdTrack: false, arucoTurn: false };
    const still = renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: EYE, noise: 2.5, seed: 1, scheme: "unique54", design });
    const r = processFrame(cv, still, 0, cfg, memory);
    const front = r.faces.find((f) => f.slot === 2)!;
    // U を 40° 回した画像を、回す前の正面の格子で読む: 上の段（0〜2）は読めないか、読めても回す前と同じステッカーではない
    const turning = renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: EYE, noise: 2.5, seed: 2, scheme: "unique54", design, turn: { move: parseMoves("U")[0], fraction: 0.45 } });
    for (const cell of [0, 1, 2]) {
      const g = gridReadCell(turning, cellH(front, cell), cell, "unique54", design, front.marker! / 0.84);
      expect(g === null || g.sticker !== front.ids![cell]).toBe(true);
    }
    // 下の 2 段は回していないので読める
    let ok = 0;
    for (const cell of [3, 4, 5, 6, 7, 8]) if (gridReadCell(turning, cellH(front, cell), cell, "unique54", design, front.marker! / 0.84)?.sticker === front.ids![cell]) ok++;
    expect(ok).toBeGreaterThanOrEqual(4);
  }, 120000);
});

describe("ライブ: 面の格子で追う（arucoGrid）", () => {
  it("30fps で回して手順が正しく、OpenCV の検出は一部のフレームだけ", () => {
    const alg = "R U R' U' F2 D L' B";
    const truth = parseMoves(alg);
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS, { observer: ARUCO_OBSERVER, decoder: { priorWeight: 0, confirmMargin: 1 } });
    const memory = {};
    const period = 350;
    const turnMs = 150;
    const lead = 300;
    let st = solvedStickers();
    let done = 0;
    let frames = 0;
    Object.assign(liveStats, { tracked: 0, gridded: 0, partial: 0, detected: 0 });
    for (let t = 0; t <= lead + truth.length * period + 400; t += 1000 / 30) {
      while (done < truth.length && t >= lead + done * period + turnMs) st = applyMoveStickers(st, truth[done++]);
      const s = lead + done * period;
      const turning = done < truth.length && t >= s;
      const img = renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: [EYE[0] + 0.1 * Math.sin(t / 300), EYE[1], EYE[2]], turn: turning ? { move: truth[done], fraction: (t - s) / turnMs, spread: 0.15 } : undefined, noise: 2, seed: Math.round(t) + 1, scheme: "unique54", design });
      const r = processFrame(cv, img, t, { ...STICKERS, arucoRegion: true, arucoTrack: true, arucoTurn: false, arucoGrid: true }, memory);
      engine.push(frameReading(t, r));
      frames++;
    }
    expect(simplifyMoves(engine.decoder.bestMoves()).map((m) => MOVE_NAMES[m.move]).join(" ")).toBe(simplifyMoves(truth.map((move, i) => ({ move, t: i, orient: 0 }))).map((m) => MOVE_NAMES[m.move]).join(" "));
    expect(liveStats.detected).toBeLessThan(frames / 3);
    expect(liveStats.gridded).toBeGreaterThan(frames / 2);
  }, 600000);
});
