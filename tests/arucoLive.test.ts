// ArUco ステッカーで普通にプレイする: 本体の認識（processFrame の ArUco の分岐）→ 追跡エンジン（ライブ）と、
// 精密解析（Refiner）で、カメラの速さ（30fps）の映像から手順を追えること。
import { beforeAll, describe, expect, it } from "vitest";
import { stickerScheme } from "../src/aruco/codes";
import { ARUCO_REFS } from "../src/aruco/palette";
import { MOVE_NAMES, VIEW, type Vec3, parseMoves, solvedState } from "../src/cube/model";
import { CERTAIN, TrackerEngine, doubtfulCells } from "../src/track/engine";
import { ARUCO_OBSERVER } from "../src/track/observer";
import { simplifyMoves } from "../src/track/merge";
import { DEFAULT_PIPELINE, frameReading, processFrame } from "../src/vision/pipeline";
import type { CV } from "../src/vision/image";
import { Refiner } from "../src/vision/refine";
import { applyMoveStickers, renderArucoCube, solvedStickers, stickerAt } from "./arucoCube";
import { loadTestOpenCv } from "./cv";

let cv: CV;
beforeAll(async () => {
  cv = await loadTestOpenCv();
}, 120000);

const SIZE = { width: 960, height: 720 };
const EYE: Vec3 = [2.4, 2.4, 5.5];
const PIPELINE = { ...DEFAULT_PIPELINE, stickers: "aruco" as const };

describe("ArUco の認識（本体の経路）", () => {
  it("正面を先頭に、カメラフレームのセルの並びで代表色を返す", () => {
    let st = solvedStickers();
    for (const m of parseMoves("R U F'")) st = applyMoveStickers(st, m);
    const img = renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: EYE, noise: 2 });
    const r = processFrame(cv, img, 0, PIPELINE, {});
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
    // アプリと同じ観測器の設定（controller.engineOptions）
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS, { observer: ARUCO_OBSERVER });
    const refiner = withRefiner ? new Refiner(cv, { state: Array.from(solvedState()), refs: ARUCO_REFS, from: 0, to: Infinity, startHint: 300, engine: { observer: ARUCO_OBSERVER }, pipeline: { stickers } }) : null;
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
      const r = processFrame(cv, img, t, pipeline, memory);
      engine.push(frameReading(t, r));
      refiner?.push(img, t);
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

describe("正面だけが見えているとき（読んだステッカーの ID・不確実性の保持）", () => {
  // カメラが正面（F）にまっすぐ向いていて、上・横の面は見えない。揃った状態で F を回し、0.8 秒後から上の面も見せる
  function run(stickers: "unique54" | "aruco12") {
    const scheme = stickerScheme(stickers);
    const pipeline = { ...PIPELINE, stickers };
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS, { observer: ARUCO_OBSERVER });
    const memory = { last: null };
    const move = parseMoves("F")[0];
    let st = solvedStickers();
    let moved = false;
    let front: { moves: string; cells: ReturnType<TrackerEngine["cellBelief"]> } | null = null;
    for (let t = 0; t <= 1500; t += 1000 / 30) {
      if (t >= 500 && !moved) {
        st = applyMoveStickers(st, move);
        moved = true;
      }
      if (t >= 800 && !front) front = { moves: engine.decoder.bestMoves().map((m) => MOVE_NAMES[m.move]).join(" "), cells: engine.cellBelief() };
      const turning = t >= 330 && t < 500;
      const eye: Vec3 = t < 800 ? [0.01, 0.02, 7.5] : [0.01, 4.5, 6.2];
      const img = renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye, turn: turning ? { move, fraction: (t - 330) / 170, spread: 0.15 } : undefined, noise: 2, seed: Math.round(t) + 1, scheme });
      const r = processFrame(cv, img, t, pipeline, memory);
      engine.push(frameReading(t, r));
    }
    return { engine, front: front! };
  }
  const frontCells = Array.from({ length: 9 }, (_, c) => VIEW[2 * 9 + c]).filter((f) => f !== 22);

  it("54 種類: 正面だけでも F の並びの変化は分かるが、キューブごと回した（z）のと区別できないので未確定のまま。上の面が見えたら決まる", () => {
    const { engine, front } = run("unique54");
    // 正面だけの間: いちばん安いのは F。ただし z（持ち替え）と見え方が同じなので、正面のマスは未確定
    expect(front.moves).toBe("F");
    for (const f of frontCells) expect(front.cells.certainty[f]).toBeLessThan(CERTAIN);
    // 上の面が見えた後: F に決まり、正面と上の面の下の段は確か。F で動いて見えていない右・下・左のマスは推定
    expect(engine.decoder.bestMoves().map((m) => MOVE_NAMES[m.move]).join(" ")).toBe("F");
    const cells = engine.cellBelief();
    for (const f of frontCells) expect(cells.certainty[f]).toBeGreaterThanOrEqual(CERTAIN);
    expect(doubtfulCells(cells).sort((a, b) => a - b)).toEqual([9, 12, 15, 27, 28, 29, 38, 41, 44]);
  }, 120000);

  it("12 種類（ID なし）: 正面だけの間は F が見えず、上の面が見えてから分かる", () => {
    const { engine, front } = run("aruco12");
    expect(front.moves).toBe("");
    expect(engine.decoder.bestMoves().map((m) => MOVE_NAMES[m.move]).join(" ")).toBe("F");
  }, 120000);
});
