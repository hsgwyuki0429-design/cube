import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { B, D, F, L, R, U, cubeFaceAt, solvedState, statesEqual, type CubeState } from "../src/cube/model";
import { DEFAULT_PIPELINE, processFrame } from "../src/vision/pipeline";
import { type CV, initOpenCv } from "../src/vision/quads";
import { FaceCapture, type ScannedFace, assembleScan, rotateCells, scanSteps } from "../src/scan/scan";
import { renderCube } from "./render";
import { rng, scrambled } from "./sim";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

const orientFor = (front: number, top: number) => Array.from({ length: 24 }, (_, o) => o).find((o) => cubeFaceAt(o, F) === front && cubeFaceAt(o, U) === top)!;
const TOPS: Record<number, number> = { [F]: U, [R]: U, [B]: U, [L]: U, [U]: B, [D]: F };

function scanCube(state: CubeState, order: number[], tops: Record<number, number> = TOPS, seed = 1): ScannedFace[] {
  const out: ScannedFace[] = [];
  const capture = new FaceCapture();
  let t = 0;
  for (const face of order) {
    const orient = orientFor(face, tops[face]);
    const memory = { last: null };
    for (let i = 0; i < 40; i++) {
      const img = renderCube({ width: 640, height: 480, state, orient, eye: [0.3, 0.6, 9], seed: seed * 100 + i });
      const r = processFrame(cv, img, t, DEFAULT_PIPELINE, memory, null);
      t += 33;
      const front = r.faces.find((f) => f.slot === F);
      const p = capture.push(front ? front.labs : null, out.map((s) => s.labs[4]));
      if (p.labs) {
        out.push({ face, labs: p.labs });
        break;
      }
    }
  }
  return out;
}

describe("6面スキャン", () => {
  it("手順どおりのスキャンでスクランブル状態を正しく組み立てる", () => {
    for (let k = 0; k < 3; k++) {
      const state = scrambled(rng(50 + k));
      const scanned = scanCube(state, scanSteps("standard").map((s) => s.face), TOPS, k + 1);
      expect(scanned.length).toBe(6);
      const r = assembleScan(scanned, "standard");
      expect(r.problems).toEqual([]);
      expect(statesEqual(r.state, state)).toBe(true);
      expect(r.names).toEqual(["W", "R", "G", "Y", "O", "B"]);
    }
  });

  it("完成状態のキューブ（キャリブレーション）", () => {
    const scanned = scanCube(solvedState(), [F, R, B, L, U, D]);
    const r = assembleScan(scanned, "standard");
    expect(r.problems).toEqual([]);
    expect(statesEqual(r.state, solvedState())).toBe(true);
  });

  it("順番を間違えても（標準配色なら）色名から位置を直す", () => {
    const state = scrambled(rng(61));
    const scanned = scanCube(state, [F, L, B, R, U, D]);
    // 手順上は F R B L U D の順のつもりで取り込まれたことにする
    const mislabeled = scanned.map((s, i) => ({ ...s, face: [F, R, B, L, U, D][i] }));
    const r = assembleScan(mislabeled, "standard");
    expect(r.problems).toEqual([]);
    expect(statesEqual(r.state, state)).toBe(true);
  });

  it("面を90°回して見せてしまっても自動で直す", () => {
    const state = scrambled(rng(71));
    const scanned = scanCube(state, [F, R, B, L, U, D]);
    scanned[1] = { ...scanned[1], labs: rotateCells(scanned[1].labs as unknown as number[], 1) as unknown as typeof scanned[1]["labs"] };
    scanned[4] = { ...scanned[4], labs: rotateCells(scanned[4].labs as unknown as number[], 2) as unknown as typeof scanned[4]["labs"] };
    const r = assembleScan(scanned, "standard");
    expect(r.problems).toEqual([]);
    expect(r.autoFixed).toBe(true);
    expect(statesEqual(r.state, state)).toBe(true);
  });
});
