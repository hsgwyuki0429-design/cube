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

// 12 種類（3×3）の符号: ステッカーの位置は分からないが、色とセンターが分かれば同じように追える
describe("12 種類（3×3）のステッカー", () => {
  let bench12: ArucoBench;
  beforeAll(() => {
    bench12 = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "aruco12");
  });
  const detect12 = (st: Sticker[], orient: number, turn?: { move: number; fraction: number; spread?: number }, size = SIZE) =>
    bench12.detect(renderArucoCube(cv, { ...size, stickers: st, orient, eye: EYE, turn, noise: 2, scheme: "aruco12" }))[0].markers;

  for (const [alg, orient, label] of [
    ["R U F' D2 L", 0, "崩した状態"],
    ["F R' U", rotateOrientation(rotateOrientation(0, "x", 1), "y", 2), "別の面が上"],
  ] as const) {
    it(`${label}: 正面・上・右のマスの色が正しい`, () => {
      const st = stickersAfter(alg);
      const faces = reconstructFaces(detect12(st, orient), SIZE, null, "aruco12").faces;
      const at = stickerAt(st);
      expect(faces.map((f) => f.slot)).toEqual([0, 1, 2]);
      for (const f of faces) {
        const want = Array.from({ length: 9 }, (_, cell) => Math.floor(at[VIEW[(orient * 6 + f.slot) * 9 + cell]] / 9));
        expect(f.colors.map((c, cell) => (c < 0 ? -1 : want[cell]))).toEqual(f.colors);
        expect(f.colors.filter((c) => c >= 0).length).toBeGreaterThanOrEqual(f.slot === 2 ? 9 : 6);
        expect(f.ids.every((id) => id === -1)).toBe(true); // 12 種類ではステッカーの位置は分からない
      }
    });
  }

  it("角をカメラに向けたとき: 正面のない割り当てになり、ライブ用（frontAlways）ではいちばんカメラを向いた面を正面にする", () => {
    const st = solvedStickers();
    const markers = bench12.detect(renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: [-3.2, 3, 3.4], noise: 2, scheme: "aruco12" }))[0].markers;
    const plain = reconstructFaces(markers, SIZE, null, "aruco12").faces;
    expect(plain.some((f) => f.slot === 2)).toBe(false);
    const live = reconstructFaces(markers, SIZE, null, "aruco12", undefined, true).faces;
    expect(live.length).toBe(3);
    expect(live.some((f) => f.slot === 2)).toBe(true);
    // 揃った状態なので面ごとに 1 色。3 面とも違う色で、向かい合う面（白と黄など）ではない
    const colors = live.map((f) => {
      const known = f.colors.filter((c) => c >= 0);
      expect(new Set(known).size).toBe(1);
      return known[0];
    });
    expect(new Set(colors).size).toBe(3);
    for (const a of colors) for (const b of colors) expect(a !== b && a % 3 === b % 3).toBe(false);
    // 割り当てた面も向かい合わない（上と下・左と右が同時に出ない）
    const slots = live.map((f) => f.slot);
    expect(slots.includes(0) && slots.includes(3)).toBe(false);
    expect(slots.includes(1) && slots.includes(4)).toBe(false);
  });

  it("回している動画から Sune を復元する", () => {
    const VIDEO_SIZE = { width: 800, height: 600 };
    const frames: { t: number; markers: Marker[] }[] = [];
    let st = solvedStickers();
    let t = 0;
    const push = (turn?: { move: number; fraction: number; spread?: number }) => {
      frames.push({ t, markers: detect12(st, 0, turn, VIDEO_SIZE) });
      t += 1000 / 240;
    };
    for (let k = 0; k < 3; k++) push();
    for (const m of parseMoves("R U R' U R U2 R'")) {
      for (const fr of [0.25, 0.5, 0.8]) push({ move: m, fraction: fr, spread: 0.12 });
      st = applyMoveStickers(st, m);
      for (let k = 0; k < 3; k++) push();
    }
    const r = decodeCube(facesOverTime(frames, VIDEO_SIZE, "aruco12"), false);
    expect(r.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe("R U R' U R U2 R'");
  }, 120000);
});

describe("マスごとに違う 54 種類（3×3）のステッカー", () => {
  let benchU: ArucoBench;
  let bench12b: ArucoBench;
  beforeAll(() => {
    benchU = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "unique54");
    bench12b = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "aruco12");
  });
  const render = (st: Sticker[], orient: number, scheme: "unique54" | "aruco12", turn?: { move: number; fraction: number; spread?: number }, size = SIZE) =>
    renderArucoCube(cv, { ...size, stickers: st, orient, eye: EYE, turn, noise: 2, scheme });

  for (const [alg, orient, label] of [
    ["R U F' D2 L", 0, "崩した状態"],
    ["F R' U", rotateOrientation(rotateOrientation(0, "x", 1), "y", 2), "別の面が上"],
  ] as const) {
    it(`${label}: 正面・上・右のマスの ID と色が正しい`, () => {
      const st = stickersAfter(alg);
      const faces = reconstructFaces(benchU.detect(render(st, orient, "unique54"))[0].markers, SIZE, null, "unique54").faces;
      const at = stickerAt(st);
      expect(faces.map((f) => f.slot)).toEqual([0, 1, 2]);
      for (const f of faces) {
        const want = Array.from({ length: 9 }, (_, cell) => at[VIEW[(orient * 6 + f.slot) * 9 + cell]]);
        expect(f.ids.map((id, cell) => (id < 0 ? -1 : want[cell]))).toEqual(f.ids);
        expect(f.colors.map((c, cell) => (c < 0 ? -1 : Math.floor(want[cell] / 9)))).toEqual(f.colors);
        expect(f.ids.filter((id) => id >= 0).length).toBeGreaterThanOrEqual(f.slot === 2 ? 9 : 6);
      }
    });
  }

  it("センターと下の段が隠れても、1 枚ずつの ID と向きから正面を組み立てる（12 種類では位置が決まらない）", () => {
    const st = stickersAfter("R U F' D2 L");
    const at = stickerAt(st);
    // 正面（F）の真ん中と下の段のステッカーを外す（指で隠れた代わり）
    const hidden = new Set([22, 24, 25, 26].map((f) => at[f]));
    const visible = st.filter((s) => !hidden.has(s.id));
    const front = (scheme: "unique54" | "aruco12", b: ArucoBench) =>
      reconstructFaces(b.detect(render(visible, 0, scheme))[0].markers, SIZE, null, scheme).faces.find((f) => f.slot === 2);
    const u = front("unique54", benchU)!;
    expect(u).toBeTruthy();
    expect(u.colors.map((c, cell) => (c < 0 ? -1 : Math.floor(at[VIEW[2 * 9 + cell]] / 9)))).toEqual(u.colors);
    expect(u.colors.filter((c) => c >= 0).length).toBe(5);
    expect(front("aruco12", bench12b)).toBeUndefined();
  });

  it("回している動画から Sune を復元する", () => {
    const VIDEO_SIZE = { width: 800, height: 600 };
    const frames: { t: number; markers: Marker[] }[] = [];
    let st = solvedStickers();
    let t = 0;
    const push = (turn?: { move: number; fraction: number; spread?: number }) => {
      frames.push({ t, markers: benchU.detect(render(st, 0, "unique54", turn, VIDEO_SIZE))[0].markers });
      t += 1000 / 240;
    };
    for (let k = 0; k < 3; k++) push();
    for (const m of parseMoves("R U R' U R U2 R'")) {
      for (const fr of [0.25, 0.5, 0.8]) push({ move: m, fraction: fr, spread: 0.12 });
      st = applyMoveStickers(st, m);
      for (let k = 0; k < 3; k++) push();
    }
    const r = decodeCube(facesOverTime(frames, VIDEO_SIZE, "unique54"), false);
    expect(r.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe("R U R' U R U2 R'");
    // 手の時刻: 止まった 3 フレーム → 回している 3 フレーム → 止まった 3 フレーム（1 フレーム 4.2ms）。
    // 回し始め〜回し終わりは回している 3 フレームを挟む（約 12〜17ms）、手と手の間は止まった 3 フレームぶん空く
    const F = 1000 / 240;
    r.moves.forEach((m, i) => {
      expect(m.t0).toBeDefined();
      expect(m.t - m.t0!).toBeGreaterThan(2.5 * F);
      expect(m.t - m.t0!).toBeLessThan(4.5 * F);
      expect(Math.abs(m.t0! - (3 + i * 6 - 0.5) * F)).toBeLessThan(1.5 * F);
      if (i) expect(m.t0! - r.moves[i - 1].t).toBeGreaterThan(1.5 * F);
    });
  }, 120000);
});

describe("1 列（1×3）・1 枚（1×1）の面", () => {
  let benchU: ArucoBench;
  let bench12c: ArucoBench;
  beforeAll(() => {
    benchU = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "unique54");
    bench12c = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "aruco12");
  });
  const st = stickersAfter("R U F' D2 L");
  const at = stickerAt(st);
  // 指定した facelet のステッカーだけ残す（他は外す = 指や手で隠れた代わり）
  const keepOnly = (face: number, keep: number[]) => st.filter((s) => {
    const fl = at.indexOf(s.id);
    return Math.floor(fl / 9) !== face || keep.includes(fl % 9);
  });
  const faceOf = (scheme: "unique54" | "aruco12", b: ArucoBench, sts: Sticker[], slot: number) =>
    reconstructFaces(b.detect(renderArucoCube(cv, { ...SIZE, stickers: sts, orient: 0, eye: EYE, noise: 2, scheme }))[0].markers, SIZE, null, scheme).faces.find((f) => f.slot === slot);
  const want = (slot: number) => Array.from({ length: 9 }, (_, cell) => Math.floor(at[VIEW[slot * 9 + cell]] / 9));

  it("54 種類: 正面の上の段だけ見えていても、その 3 マスを使う", () => {
    const f = faceOf("unique54", benchU, keepOnly(2, [0, 1, 2]), 2)!;
    expect(f.partial).toBe(true);
    expect(f.colors).toEqual(want(2).map((c, cell) => (cell < 3 ? c : -1)));
  });

  it("54 種類: 右の面に 1 枚だけ見えていても、そのマスを使う", () => {
    const f = faceOf("unique54", benchU, keepOnly(1, [3]), 1)!;
    expect(f.partial).toBe(true);
    expect(f.colors.filter((c) => c >= 0).length).toBe(1);
    expect(f.colors.map((c, cell) => (c < 0 ? -1 : want(1)[cell]))).toEqual(f.colors);
  });

  it("12 種類: センター 1 枚だけ見えている面は、真ん中のマス（その面の色）を使う", () => {
    const f = faceOf("aruco12", bench12c, keepOnly(1, [4]), 1)!;
    expect(f.partial).toBe(true);
    expect(f.colors).toEqual([-1, -1, -1, -1, want(1)[4], -1, -1, -1, -1]);
  });
});
