// キューブモード（src/aruco/cube.ts）: ArUco ステッカーを貼ったキューブの合成画像から、見えている面を組み立て、
// 回している動画（240fps 相当）から手順を復元する。
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { type CubeFrame, decodeCube, facesOverTime, reconstructFaces } from "../src/aruco/cube";
import { ArucoBench, DEFAULT_CONFIGS, type Marker } from "../src/aruco/detect";
import { MOVE_NAMES, VIEW, type Vec3, parseMoves, rotateOrientation } from "../src/cube/model";
import { type CV, initOpenCv } from "../src/vision/quads";
import { type Sticker, applyMoveStickers, renderArucoCube, solvedStickers, stickerAt } from "./arucoCube";

let cv: CV;
let bench: ArucoBench;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  bench = new ArucoBench(cv, [DEFAULT_CONFIGS[1]]); // max(RGB)
}, 120000);

const EYE: Vec3 = [2.4, 2.4, 5.5]; // 正面・上・右が見える（スタンドで少し上から、20cm 前後）
const SIZE = { width: 1024, height: 768 };

function stickersAfter(alg: string): Sticker[] {
  let st = solvedStickers();
  for (const m of parseMoves(alg)) st = applyMoveStickers(st, m);
  return st;
}

function detect(st: Sticker[], orient: number, turn?: { move: number; fraction: number; spread?: number }, size = SIZE) {
  const img = renderArucoCube(cv, { ...size, stickers: st, orient, eye: EYE, turn, noise: 2 });
  return bench.detect(img)[0].markers;
}

describe("見えている面の組み立て", () => {
  for (const [alg, orient, label] of [
    ["", 0, "揃った状態"],
    ["R U F' D2 L", 0, "崩した状態"],
    ["R U2 B'", rotateOrientation(0, "y", 1), "持ち替えた姿勢"],
    ["F R' U", rotateOrientation(rotateOrientation(0, "x", 1), "y", 2), "別の面が上"],
  ] as const) {
    // 斜めに写る面の遠い角は小さくて読めないことがある（-1）。読めたマスは必ず正しいこと
    it(`${label}: 正面・上・右のマスの ID が正しい`, () => {
      const st = stickersAfter(alg);
      const faces = reconstructFaces(detect(st, orient), SIZE).faces;
      const at = stickerAt(st);
      expect(faces.map((f) => f.slot)).toEqual([0, 1, 2]);
      for (const f of faces) {
        const want = Array.from({ length: 9 }, (_, cell) => at[VIEW[(orient * 6 + f.slot) * 9 + cell]]);
        expect(f.ids.map((id, cell) => (id < 0 ? -1 : want[cell]))).toEqual(f.ids);
        expect(f.ids.filter((id) => id >= 0).length).toBeGreaterThanOrEqual(f.slot === 2 ? 9 : 6);
      }
    });
  }

  it("回している途中の層は外す（残りのセルは正しい）", () => {
    const st = stickersAfter("");
    const tilt = reconstructFaces(detect(st, 0), SIZE).tilt;
    const faces = reconstructFaces(detect(st, 0, { move: parseMoves("U")[0], fraction: 0.4 }), SIZE, tilt).faces;
    const at = stickerAt(st);
    // 回っている層の向こうのセルは読めないことがある。読めたマスは回す前の状態のとおりで、回っている段は入らない
    expect(faces.length).toBeGreaterThan(0);
    for (const f of faces) {
      const want = Array.from({ length: 9 }, (_, cell) => at[VIEW[f.slot * 9 + cell]]);
      expect(f.ids.map((id, cell) => (id < 0 ? -1 : want[cell]))).toEqual(f.ids);
      if (f.slot !== 0) expect(f.ids.slice(0, 3)).toEqual([-1, -1, -1]);
    }
    expect(faces.find((f) => f.slot === 0)?.ids.filter((id) => id >= 0).length).toBeGreaterThanOrEqual(7);
  });
});

describe("回している動画から手順を復元する", () => {
  // 240fps 相当: 回す前後は止まったフレーム、回す途中はぶれ付き。テストの時間のため、回す途中は 3 枚・止まった間は 3 枚に間引く
  const VIDEO_SIZE = { width: 800, height: 600 };
  function video(alg: string, orient = 0): CubeFrame[] {
    const frames: { t: number; markers: Marker[] }[] = [];
    let st = solvedStickers();
    let t = 0;
    const push = (turn?: { move: number; fraction: number; spread?: number }) => {
      frames.push({ t, markers: detect(st, orient, turn, VIDEO_SIZE) });
      t += 1000 / 240;
    };
    for (let k = 0; k < 3; k++) push();
    for (const m of parseMoves(alg)) {
      for (const fr of [0.25, 0.5, 0.8]) push({ move: m, fraction: fr, spread: 0.12 });
      st = applyMoveStickers(st, m);
      for (let k = 0; k < 3; k++) push();
    }
    return facesOverTime(frames, VIDEO_SIZE);
  }

  it("Sune（R U R' U R U2 R'）", () => {
    const r = decodeCube(video("R U R' U R U2 R'"), false);
    expect(r.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe("R U R' U R U2 R'");
    expect(r.moves.every((m) => !m.inferred)).toBe(true);
  }, 120000);

  it("T-perm を 2 回（最後は揃う）・持ち替えた姿勢", () => {
    const tperm = "R U R' U' R' F R2 U' R' U' R U R' F'";
    const r = decodeCube(video(`${tperm} ${tperm}`, rotateOrientation(0, "y", 1)), true);
    expect(r.reachedEnd).toBe(true);
    expect(r.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe(`${tperm} ${tperm}`);
  }, 300000);
});
