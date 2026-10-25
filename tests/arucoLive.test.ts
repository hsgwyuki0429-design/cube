// ArUco ステッカーで普通にプレイする: 本体の認識（processFrame の ArUco の分岐）→ 追跡エンジン（ライブ）と、
// 精密解析（Refiner）で、カメラの速さ（30fps）の映像から手順を追えること。
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { stickerScheme } from "../src/aruco/codes";
import { ARUCO_REFS } from "../src/aruco/palette";
import { MOVE_NAMES, VIEW, type Vec3, parseMoves, solvedState } from "../src/cube/model";
import { TrackerEngine } from "../src/track/engine";
import { simplifyMoves } from "../src/track/merge";
import { DEFAULT_PIPELINE, processFrame } from "../src/vision/pipeline";
import { type CV, initOpenCv } from "../src/vision/quads";
import { Refiner } from "../src/vision/refine";
import { applyMoveStickers, renderArucoCube, solvedStickers, stickerAt } from "./arucoCube";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

const SIZE = { width: 960, height: 720 };
const EYE: Vec3 = [2.4, 2.4, 5.5];
const PIPELINE = { ...DEFAULT_PIPELINE, stickers: "aruco" as const };

describe("ArUco の認識（本体の経路）", () => {
  it("正面を先頭に、カメラフレームのセルの並びで代表色を返す", () => {
    let st = solvedStickers();
    for (const m of parseMoves("R U F'")) st = applyMoveStickers(st, m);
    const img = renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: EYE, noise: 2 });
    const r = processFrame(cv, img, 0, PIPELINE, { last: null }, ARUCO_REFS);
    expect(r.faces[0].slot).toBe(2);
    const at = stickerAt(st);
    for (const f of r.faces) {
      f.labs.forEach((lab, cell) => {
        if (!f.valid[cell]) return;
        expect(lab).toEqual(ARUCO_REFS[Math.floor(at[VIEW[f.slot * 9 + cell]] / 9)]);
      });
      expect(f.valid.filter(Boolean).length).toBeGreaterThanOrEqual(f.slot === 2 ? 9 : 6);
    }
  });
});

describe("30fps のカメラで回す（揃った状態から）", () => {
  const alg = "R U R' U' F2 D L' B";
  function run(withRefiner: boolean, stickers: "aruco" | "aruco12" | "unique54" = "aruco") {
    const scheme = stickerScheme(stickers);
    const pipeline = { ...PIPELINE, stickers };
    const truth = parseMoves(alg);
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS);
    const refiner = withRefiner ? new Refiner(cv, { state: Array.from(solvedState()), refs: ARUCO_REFS, from: 0, to: Infinity, startHint: 300, engine: {}, pipeline: { stickers } }) : null;
    const memory = { last: null };
    const period = 400; // 2.5 手/秒
    const turnMs = 170;
    const lead = 300;
    const total = lead + truth.length * period + 400;
    let st = solvedStickers();
    let done = 0;
    for (let t = 0; t <= total; t += 1000 / 30) {
      // t の時点で回し終わった手を反映し、回している途中の手は途中の角度で描く（露光中のぶれ付き）
      while (done < truth.length && t >= lead + done * period + turnMs) st = applyMoveStickers(st, truth[done++]);
      const s = lead + done * period;
      const turning = done < truth.length && t >= s;
      const fr = turning ? (t - s) / turnMs : 0;
      const img = renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: [EYE[0] + 0.1 * Math.sin(t / 300), EYE[1], EYE[2]], turn: turning ? { move: truth[done], fraction: fr, spread: 0.15 } : undefined, noise: 2, seed: Math.round(t) + 1, scheme });
      const r = processFrame(cv, img, t, pipeline, memory, engine.colors.refs);
      engine.push({ t, faces: r.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid, weight: f.weight, spread: f.spread, masked: f.masked })) });
      refiner?.push(img, t, []);
    }
    return { engine, refiner, truth };
  }

  it("ライブの追跡と精密解析で手順が正しい", () => {
    const { engine, refiner, truth } = run(true);
    const live = simplifyMoves(engine.decoder.bestMoves()).map((m) => MOVE_NAMES[m.move]).join(" ");
    expect(live).toBe(truth.map((m) => MOVE_NAMES[m]).join(" "));
    const rr = refiner!.result(null);
    expect(rr.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe(alg);
  }, 300000);

  it("マスごとに違う 54 種類（3×3）のステッカーで、ライブの追跡と精密解析で手順が正しい", () => {
    const { engine, refiner, truth } = run(true, "unique54");
    const live = simplifyMoves(engine.decoder.bestMoves()).map((m) => MOVE_NAMES[m.move]).join(" ");
    expect(live).toBe(truth.map((m) => MOVE_NAMES[m]).join(" "));
    expect(refiner!.result(null).moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe(alg);
  }, 300000);

  it("12 種類（3×3）のステッカーでも、ライブの追跡で手順が正しい", () => {
    const { engine, truth } = run(false, "aruco12");
    const live = simplifyMoves(engine.decoder.bestMoves()).map((m) => MOVE_NAMES[m.move]).join(" ");
    expect(live).toBe(truth.map((m) => MOVE_NAMES[m]).join(" "));
  }, 300000);
});
