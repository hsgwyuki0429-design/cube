// ソルブ後の精密解析: 処理が追いつかない端末のリアルタイム追跡（4フレームに1枚）でも、
// 全フレームを解析し直せば、10手/秒の手順とタイム（最初の手の回し始め〜最後の手の回し終わり）が正確に出ること
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { type CV, initOpenCv } from "../src/vision/quads";
import { simulate } from "./speed";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 60000);

describe("live tracking at 10 TPS", () => {
  it("follows every move at 30fps with motion blur, fingers and hand wobble", () => {
    const r = simulate(cv, { seed: 1, moves: 12, tps: 10, fps: 30, exposureMs: 12, solveTo: true });
    expect(r.accuracy).toBe(1);
    expect(r.final).toBe(true);
    expect(r.solved).toBe(true);
  }, 180000);
});

describe("refine (post-solve analysis)", () => {
  it("reconstructs a 10 TPS solve at 60fps with frame-accurate time", () => {
    const r = simulate(cv, { seed: 2, moves: 10, tps: 10, fps: 60, exposureMs: 8, solveTo: true, every: 4, refine: true });
    const f = r.refined!;
    expect(f.solved).toBe(true);
    expect(f.accuracy).toBe(1);
    expect(f.forced).toBe(0);
    // フレーム間隔 16.7ms の半分程度
    expect(Math.abs(f.start! - r.startTruth)).toBeLessThanOrEqual(10);
    expect(Math.abs(f.end! - r.endTruth)).toBeLessThanOrEqual(10);
  }, 180000);

  it("reconstructs at 30fps", () => {
    const r = simulate(cv, { seed: 3, moves: 10, tps: 10, fps: 30, exposureMs: 12, solveTo: true, every: 2, refine: true });
    const f = r.refined!;
    expect(f.solved).toBe(true);
    expect(f.accuracy).toBe(1);
    expect(Math.abs(f.start! - r.startTruth)).toBeLessThanOrEqual(18);
    expect(Math.abs(f.end! - r.endTruth)).toBeLessThanOrEqual(18);
  }, 180000);

  it("marks the start uncertain when the solve began before the analysis range", () => {
    // 最初の手（600〜770ms）が終わった後から解析する: 開始は録画から決められない
    const r = simulate(cv, { seed: 4, moves: 6, tps: 4, fps: 30, exposureMs: 12, solveTo: true, refine: true, refineFrom: 800 });
    expect(r.refined!.startUncertain).toBe(true);
  }, 180000);

  it("times a solve under glare and heavy finger occlusion within about half a frame", () => {
    // 艶の映り込み・色合い・多くの指・不正確な手の検出（4 手/秒・30fps）
    const r = simulate(cv, { seed: 1, moves: 10, tps: 4, fps: 30, exposureMs: 12, solveTo: true, refine: true, scene: { harshness: "real", fingers: "heavy", maskQuality: 0.5 } });
    const f = r.refined!;
    expect(f.solved).toBe(true);
    expect(f.startUncertain).toBe(false);
    expect(Math.abs(f.start! - r.startTruth)).toBeLessThanOrEqual(25);
    expect(Math.abs(f.end! - r.endTruth)).toBeLessThanOrEqual(40);
  }, 400000);
});
