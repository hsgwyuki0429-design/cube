import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { D, F, L, R, U, VIEW, rotateOrientation, type Vec3 } from "../src/cube/model";
import { type Lab, colorDistance, rgbToLab } from "../src/vision/color";
import { findFaces } from "../src/vision/lattice";
import { stickerScore } from "../src/vision/stickerness";
import { layoutFaces } from "../src/vision/layout";
import { type CV, findQuads, initOpenCv } from "../src/vision/quads";
import { sampleFace } from "../src/vision/sampler";
import { PALETTE, renderCube } from "./render";
import { rng, scrambled } from "./sim";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

const PAL_LAB: Lab[] = PALETTE.map(([r, g, b]) => rgbToLab(r, g, b));
const classify = (lab: Lab) => PAL_LAB.map((p) => colorDistance(lab, p)).reduce((bi, d, i, arr) => (d < arr[bi] ? i : bi), 0);

function detect(img: { data: Uint8ClampedArray; width: number; height: number }) {
  const mat = cv.matFromImageData(img);
  try {
    const quads = findQuads(cv, mat);
    const scorer = (pt: [number, number]) => {
      const x = Math.round(pt[0]);
      const y = Math.round(pt[1]);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) return -1;
      const k = (y * img.width + x) * 4;
      return stickerScore(rgbToLab(img.data[k], img.data[k + 1], img.data[k + 2]));
    };
    const faces = findFaces(quads, {}, scorer);
    return { quads, faces, placed: layoutFaces(faces) };
  } finally {
    mat.delete();
  }
}

function check(eye: Vec3, orient: number, seed: number, expectSlots: number[], extra: Partial<Parameters<typeof renderCube>[0]> = {}) {
  const rnd = rng(seed);
  const state = scrambled(rnd);
  const img = renderCube({ width: 640, height: 480, state, orient, eye, seed, ...extra });
  const { placed, quads } = detect(img);
  const reads = placed.map((p) => ({ slot: p.slot, labels: sampleFace(img, p).map((s) => classify(s.lab)) }));
  // カメラフレームのラベル付けは「最も大きく見える面 = F」なので、レンダラの世界座標とは
  // 持ち替え（姿勢）の分だけずれうる。どれかの姿勢で全部の面が一致すれば正しく読めている
  let bestO = orient;
  let bestCorrect = -1;
  for (let o = 0; o < 24; o++) {
    let c = 0;
    for (const r of reads) r.labels.forEach((l, cell) => (c += l === state[VIEW[(o * 6 + r.slot) * 9 + cell]] ? 1 : 0));
    if (c > bestCorrect || (c === bestCorrect && o === orient)) {
      bestCorrect = c;
      bestO = o;
    }
  }
  const result: Record<number, { correct: number; total: number }> = {};
  for (const r of reads) {
    let correct = 0;
    r.labels.forEach((l, cell) => (correct += l === state[VIEW[(bestO * 6 + r.slot) * 9 + cell]] ? 1 : 0));
    result[r.slot] = { correct, total: 9 };
  }
  return { result, quads: quads.length, slots: placed.map((p) => p.slot).sort(), expect: [...expectSlots].sort(), sameFrame: bestO === orient };
}

describe("face locator (OpenCV.js + lattice + layout)", () => {
  it("正面から：F の1面を正しい向きで読む", () => {
    const r = check([0, 0, 10], 0, 1, [F]);
    expect(r.slots).toEqual([F]);
    expect(r.result[F].correct).toBe(9);
  });

  it("やや上から：F と U の2面を読む", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const r = check([0.6, 4.5, 9], 0, seed, [F, U]);
      expect(r.slots, `seed ${seed}`).toEqual(r.expect);
      expect(r.result[F].correct, `seed ${seed} F`).toBe(9);
      expect(r.result[U].correct, `seed ${seed} U`).toBe(9);
    }
  });

  it("角から：F・U・R の3面を読む", () => {
    let ok = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const r = check([5, 5, 8], 0, seed, [F, U, R]);
      if (r.slots.join() === r.expect.join() && Object.values(r.result).every((x) => x.correct === 9)) ok++;
      else process.stdout.write(`corner seed ${seed}: slots=${r.slots} ${JSON.stringify(r.result)} quads=${r.quads}\n`);
    }
    expect(ok).toBeGreaterThanOrEqual(5);
  });

  it("画像内で傾いたキューブ（カメラを roll）でも向きを保つ", () => {
    const r = check([0, 4.5, 9], 0, 3, [F, U], { up: [0.35, 1, 0] });
    expect(r.slots).toEqual(r.expect);
    expect(r.result[F].correct).toBe(9);
    expect(r.result[U].correct).toBe(9);
  });

  it("指でステッカーが2〜3枚隠れても面を見つける", () => {
    const r = check([0, 3, 10], 0, 4, [F, U], {
      occluders: [{ center: [360, 330], radius: 38, color: [215, 160, 130] }],
    });
    expect(r.slots).toContain(F);
  });

  it("持ち替えた姿勢でも、正面に来ている面の色を読む", () => {
    const o = rotateOrientation(rotateOrientation(0, "y"), "x");
    const r = check([0.5, 4, 9], o, 5, [F, U]);
    expect(r.slots).toEqual(r.expect);
    expect(r.result[F].correct + r.result[U].correct).toBe(18);
  });

  it("左下から：F・L・D", () => {
    const r = check([-5, -4, 8], 0, 6, [F, L, D]);
    expect(r.slots).toEqual(r.expect);
  });

  it("ランダムな姿勢での検出率（正面の面は常に、2面目も大半で正しく読める）", () => {
    const rnd = rng(77);
    let frontOk = 0;
    let allOk = 0;
    let multi = 0;
    const N = 40;
    for (let k = 0; k < N; k++) {
      const az = (rnd() - 0.5) * 1.6; // ±46°
      const el = 0.3 + rnd() * 0.55; // 17°〜49°
      const dist = 8 + rnd() * 5;
      const eye: Vec3 = [dist * Math.sin(az) * Math.cos(el), dist * Math.sin(el), dist * Math.cos(az) * Math.cos(el)];
      const roll = (rnd() - 0.5) * 0.8;
      const r = check(eye, Math.floor(rnd() * 24), 1000 + k, [], { up: [Math.sin(roll), Math.cos(roll), 0] });
      const slots = Object.keys(r.result).map(Number);
      const anchorSlot = F;
      if (r.result[anchorSlot]?.correct === 9) frontOk++;
      if (slots.length >= 2) multi++;
      if (slots.length && slots.every((s) => r.result[s].correct === 9)) allOk++;
    }
    process.stdout.write(`random poses: front ${frontOk}/${N}, all-correct ${allOk}/${N}, 2+ faces ${multi}/${N}\n`);
    expect(frontOk).toBeGreaterThanOrEqual(N * 0.9);
    expect(allOk).toBeGreaterThanOrEqual(N * 0.85);
    expect(multi).toBeGreaterThanOrEqual(N * 0.6);
  });
});
