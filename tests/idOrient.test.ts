// 実物のソルブ動画で分かったこと（tests/debug/realVideo.debug.test.ts）:
// - 正面 1 面だけが見えて真ん中が指で隠れたまま持ち替えると、いまの姿勢のまま手で説明して見失っていた → 読んだステッカーの ID から姿勢を求める
// - 上の段がずれた正面を、正面と下の面の 2 つに組み立てていた（同じステッカーが 2 か所）→ 少ない方の面を捨てる
import { describe, expect, it } from "vitest";
import { F, VIEW, cubeFaceAt } from "../src/cube/model";
import { stickerIds } from "../src/cube/stickers";
import type { VisibleFace } from "../src/aruco/cube";
import { MoveDecoder } from "../src/track/decoder";
import { dedupeStickers } from "../src/vision/arucoFrame";
import { observe, rng, scrambled } from "./sim";

const clean = { misread: 0, hidden: 0, mismatchCost: 1.5 };

describe("姿勢をステッカーの ID から求める", () => {
  it("真ん中が隠れた正面だけでも、持ち替えを手でなく持ち替えとして読む", () => {
    const rnd = rng(7);
    const state = scrambled(rnd, 20);
    // 正面に別の面が来る持ち替え
    const o2 = [...Array(24).keys()].find((o) => cubeFaceAt(o, F) !== cubeFaceAt(0, F))!;
    const ids = stickerIds(state);
    const dec = new MoveDecoder(state, { priorWeight: 0 }, [0]);
    for (const [t, o] of [
      [100, 0],
      [400, o2],
      [700, o2],
    ] as const) {
      const obs = observe(state, o, [F], t, t - 50, rnd, clean);
      const f = obs.faces[0];
      // 真ん中は指で隠れている
      f.labels[4] = -1;
      f.cost.fill(0, 24, 30);
      f.ids = Int16Array.from({ length: 9 }, (_, cell) => (cell === 4 ? -1 : ids[VIEW[(o * 6 + F) * 9 + cell]]));
      f.idCost = new Float32Array(9).fill(1);
      dec.observe(obs);
    }
    expect(dec.best().orient).toBe(o2);
    expect(dec.bestMoves()).toEqual([]);
  });
});

describe("同じステッカーが 2 か所に読めた面", () => {
  const face = (slot: number, ids: number[], partial = false): VisibleFace => ({
    slot,
    ids: [...ids],
    colors: ids.map((id) => (id < 0 ? -1 : Math.floor(id / 9))),
    conf: ids.map(() => 1),
    outline: [],
    H: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    ...(partial ? { partial } : {}),
  });
  it("読めたステッカーの少ない方の面を捨てる", () => {
    const front = face(2, [15, 21, 38, -1, -1, -1, -1, 46, -1]);
    const bottom = face(3, [15, -1, 38, 50, 49, 43, -1, -1, -1]);
    const top = face(0, [20, 28, 53, 32, 31, 34, 26, 41, 6]);
    expect(dedupeStickers([front, bottom, top]).map((f) => f.slot)).toEqual([3, 0]);
  });
  it("同じ数なら正面を残す", () => {
    const front = face(2, [15, 21, -1, -1, -1, -1, -1, -1, -1]);
    const bottom = face(3, [15, 50, -1, -1, -1, -1, -1, -1, -1]);
    expect(dedupeStickers([bottom, front]).map((f) => f.slot)).toEqual([2]);
  });
  it("1 つの面の中で重なったマスはどちらも読めないことにする", () => {
    const f = face(2, [15, 21, 15, 3, -1, -1, -1, -1, -1]);
    const [out] = dedupeStickers([f, face(0, [0, 1, 2, -1, -1, -1, -1, -1, -1])]);
    expect(out.ids).toEqual([-1, 21, -1, 3, -1, -1, -1, -1, -1]);
    expect(out.colors[0]).toBe(-1);
  });
});
