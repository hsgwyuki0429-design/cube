import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { B, D, F, L, R, U, cubeFaceAt, solvedState, statesEqual, type CubeState } from "../src/cube/model";
import { DEFAULT_PIPELINE, processFrame } from "../src/vision/pipeline";
import { type CV, initOpenCv } from "../src/vision/quads";
import { FaceCapture, type ScannedFace, assembleScan, rotateCells, scanSteps } from "../src/scan/scan";
import { type SceneOptions, scene } from "./realism";
import { axisAngle, renderCube } from "./render";
import { rng, scrambled } from "./sim";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

const orientFor = (front: number, top: number) => Array.from({ length: 24 }, (_, o) => o).find((o) => cubeFaceAt(o, F) === front && cubeFaceAt(o, U) === top)!;
const TOPS: Record<number, number> = { [F]: U, [R]: U, [B]: U, [L]: U, [U]: B, [D]: F };

// realistic: 実物らしい条件（艶の映り込み・色合い・ぼけ・持つ指・手の揺れ）
function scanCube(state: CubeState, order: number[], tops: Record<number, number> = TOPS, seed = 1, realistic?: SceneOptions, frameLog?: number[]): ScannedFace[] {
  const out: ScannedFace[] = [];
  const capture = new FaceCapture();
  const rnd = rng(seed * 7 + 1);
  let t = 0;
  for (const face of order) {
    const orient = orientFor(face, tops[face]);
    const memory = { last: null };
    let used = 0;
    for (let i = 0; i < (realistic ? 120 : 40); i++) {
      used++;
      // 手持ちの揺れ: 少し傾き、少し動く
      const rotation = realistic ? axisAngle([Math.sin(t / 500), 1, Math.cos(t / 700)].map((v, _, a) => v / Math.hypot(...a)) as [number, number, number], 0.12 * Math.sin(t / 380)) : undefined;
      const base = { width: 640, height: 480, orient, eye: [0.3, 0.6 + (realistic ? 1.6 : 0), 9] as [number, number, number], rotation, offset: realistic ? ([0.15 * Math.sin(t / 450), 0.1 * Math.cos(t / 520), 0] as [number, number, number]) : undefined };
      const sc = realistic ? scene(base, t, realistic, rnd) : null;
      const img = renderCube({ ...base, state, seed: seed * 100 + i, realism: sc?.realism });
      const r = processFrame(cv, img, t, DEFAULT_PIPELINE, memory, null, sc?.hands ?? []);
      t += 33;
      const front = r.faces.find((f) => f.slot === F);
      const p = capture.push(front ? { labs: front.labs, valid: front.valid.map((v, k) => v && !front.masked[k]) } : null, out.map((s) => s.labs[4]));
      if (p.labs) {
        out.push({ face, labs: p.labs });
        break;
      }
    }
    frameLog?.push(used);
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

  // 実物らしい条件: 艶の映り込みが動き、カメラの色合いで白がクリーム色になり、親指がマスを隠し、手が揺れる
  for (const [name, so] of [
    ["映り込み・色合い・親指（手の検出あり）", { harshness: "real", fingers: "hold", maskQuality: 1 }],
    ["映り込み・色合い・親指（手の検出が不正確）", { harshness: "real", fingers: "hold", maskQuality: 0.5 }],
    ["強い映り込み・白飛び・多くの指・チェックの背景", { harshness: "harsh", fingers: "heavy", maskQuality: 0.7, backdrop: "plaid" }],
  ] as [string, SceneOptions][]) {
    it(`実物らしい条件でもスキャンできる: ${name}`, () => {
      for (let k = 0; k < 2; k++) {
        const state = scrambled(rng(90 + k));
        const frames: number[] = [];
        const scanned = scanCube(state, scanSteps("standard").map((st) => st.face), TOPS, k + 3, so, frames);
        expect(scanned.length, `frames per face ${frames}`).toBe(6);
        const r = assembleScan(scanned, "standard");
        expect(r.problems).toEqual([]);
        expect(statesEqual(r.state, state), `uncertain ${r.uncertain}`).toBe(true);
      }
    }, 240000);
  }

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
