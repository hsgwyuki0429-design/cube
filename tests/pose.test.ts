// 連続的な姿勢の推定: 合成画像（既知の視点・傾き）から、カメラに対するキューブの回転が求まること
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { ORIENTATIONS, type Vec3, solvedState } from "../src/cube/model";
import { type Lab, rgbToLab } from "../src/vision/color";
import { DEFAULT_PIPELINE, processFrame } from "../src/vision/pipeline";
import { estimatePose, projectSlot, rotationAngle } from "../src/vision/pose";
import { slotPoint } from "../src/vision/layout";
import { type CV, initOpenCv } from "../src/vision/quads";
import { PALETTE, axisAngle, mulMat, renderCube } from "./render";
import { rng, scrambled } from "./sim";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

const REFS: Lab[] = PALETTE.map(([r, g, b]) => rgbToLab(r * 0.85, g * 0.85, b * 0.85));

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// 描画したキューブの、キューブ固定フレーム → カメラフレーム（x 右・y 上・z 手前）の回転
function truthRotation(eye: Vec3, rotation: number[] | undefined, orient: number): number[] {
  const fwd = norm(sub([0, 0, 0], eye));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const cam = [...right, ...up, -fwd[0], -fwd[1], -fwd[2]];
  const world = rotation ? mulMat(rotation, ORIENTATIONS[orient]) : [...ORIENTATIONS[orient]];
  return mulMat(cam, world);
}

function estimate(eye: Vec3, rotation?: number[], orient = 0, seed = 1) {
  const w = 640;
  const h = 480;
  const img = renderCube({ width: w, height: h, state: seed ? scrambled(rng(seed)) : solvedState(), orient, eye, rotation, seed });
  const memory = { last: null };
  const r = processFrame(cv, img, 0, DEFAULT_PIPELINE, memory, REFS, []);
  const pose = estimatePose(r.faces, w, h, w * 1.1);
  return { pose, faces: r.faces };
}

describe("pose", () => {
  const cases: { name: string; eye: Vec3; rotation?: number[] }[] = [
    { name: "front-above", eye: [0.8, 4.5, 9] },
    { name: "corner", eye: [5, 5, 8] },
    { name: "tilted 20° about y", eye: [0.8, 4.5, 9], rotation: axisAngle([0, 1, 0], (20 * Math.PI) / 180) },
    { name: "rolled 15° about z", eye: [0.5, 3, 9], rotation: axisAngle([0, 0, 1], (15 * Math.PI) / 180) },
  ];
  for (const c of cases) {
    it(`recovers the camera-relative rotation (${c.name})`, () => {
      const { pose, faces } = estimate(c.eye, c.rotation);
      expect(pose).not.toBeNull();
      expect(faces.length).toBeGreaterThanOrEqual(1);
      // 認識が割り当てたカメラフレームの面 × 残りの回転 = 実際の回転。正面が F・上が U なので離散的な姿勢は 0
      const truth = truthRotation(c.eye, c.rotation, 0);
      const angle = (rotationAngle(pose!.R, truth) * 180) / Math.PI;
      expect(angle).toBeLessThan(3);
      expect(pose!.err).toBeLessThan(3);
    });
  }

  it("is robust to an assumed focal length that is off by 30%", () => {
    const eye: Vec3 = [3, 4, 8];
    const w = 640;
    const img = renderCube({ width: w, height: 480, state: scrambled(rng(3)), orient: 0, eye, seed: 3 });
    const r = processFrame(cv, img, 0, DEFAULT_PIPELINE, { last: null }, REFS, []);
    const pose = estimatePose(r.faces, w, 480, w * 0.8);
    const angle = (rotationAngle(pose!.R, truthRotation(eye, undefined, 0)) * 180) / Math.PI;
    expect(angle).toBeLessThan(8);
  });

  it("predicts the neighbouring faces' grids from the front face alone", () => {
    // 正面だけから求めた姿勢で上の面・右の面の格子を射影し、実際に検出した格子と比べる
    for (const eye of [[0.8, 4.5, 9], [5, 5, 8]] as Vec3[]) {
      const w = 640;
      const img = renderCube({ width: w, height: 480, state: scrambled(rng(5)), orient: 0, eye, seed: 5 });
      const r = processFrame(cv, img, 0, DEFAULT_PIPELINE, { last: null }, REFS, []);
      const front = r.faces.find((f) => f.slot === 2 && !f.held)!;
      const pose = estimatePose([front], w, 480, w * 1.1)!;
      expect(pose).not.toBeNull();
      for (const other of r.faces.filter((f) => f.slot !== 2 && !f.held)) {
        const pred = projectSlot(pose, other.slot, w, 480, w * 1.1)!;
        expect(pred).not.toBeNull();
        const pitch = Math.hypot(...([0, 1].map((k) => slotPoint(front, 1, 1)[k] - slotPoint(front, 2, 1)[k]) as [number, number]));
        for (const [x, y] of [[0.5, 0.5], [1.5, 1.5], [2.5, 2.5], [0.5, 2.5], [2.5, 0.5]]) {
          const a = slotPoint({ H: pred.H, rot: 0 }, x, y);
          const b = slotPoint(other, x, y);
          expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(pitch * 0.3);
        }
      }
    }
  });
});
