// キューブ全体の向きを手とは別に追う（src/track/orient.ts）と、それを使うデコーダ（trackedOrient）
import { describe, expect, it } from "vitest";
import { ARUCO_REFS } from "../src/aruco/palette";
import { VIEW, applyMove, moveIndex, rotateOrientation, solvedState } from "../src/cube/model";
import { stickerIds } from "../src/cube/stickers";
import { TrackerEngine } from "../src/track/engine";
import { ARUCO_OBSERVER, type FaceReading, type FrameReading, LIVE_OBSERVER } from "../src/track/observer";
import { CELL_MAP, LIVE_TRACKED_ORIENT, OrientTracker } from "../src/track/orient";
import type { SightFrame } from "../src/track/sight";

type Quad = number[];
// 画像の上の四角（左上・右上・右下・左下）
const square = (x: number, y: number, s: number): Quad => [x, y, x + s, y, x + s, y + s, x, y + s];
// 格子を時計回りに r × 90° 回した外枠（隅の並びを回す）
const turnQuad = (q: Quad, r: number): Quad => Array.from({ length: 8 }, (_, i) => q[(((i >> 1) - r + 4) % 4) * 2 + (i & 1)]);

function face(slot: number, ids: number[], hide: number[] = []): FaceReading {
  return {
    slot,
    ids: ids.map((id, c) => (hide.includes(c) ? -1 : id)),
    labs: ids.map((id) => ARUCO_REFS[Math.floor(id / 9)]),
    valid: ids.map((_, c) => !hide.includes(c)),
  };
}
function frame(t: number, faces: { f: FaceReading; quad: Quad }[]): { reading: FrameReading; sight: SightFrame } {
  return {
    reading: { t, faces: faces.map((x) => x.f) },
    sight: { t, faces: faces.map((x) => ({ slot: x.f.slot, ids: x.f.ids!, rot: new Array(9).fill(0), quad: x.quad })) },
  };
}
// 状態 state を姿勢 o で見たとき、カメラの面 slot に見えるステッカー
const idsAt = (state: Uint8Array, o: number, slot: number) => {
  const ids = stickerIds(state);
  return Array.from({ length: 9 }, (_, c) => ids[VIEW[(o * 6 + slot) * 9 + c]]);
};

describe("OrientTracker", () => {
  const s = solvedState();
  const ids = idsAt(s, 0, 2);
  const q = square(100, 100, 90);

  it("同じ面の同じマスに残ったステッカーは動いていない", () => {
    const tr = new OrientTracker();
    let a = frame(0, [{ f: face(2, ids), quad: q }]);
    tr.push(a.reading, a.sight);
    a = frame(33, [{ f: face(2, ids), quad: square(104, 98, 90) }]);
    tr.push(a.reading, a.sight);
    expect(tr.stillSince(0).still.sort()).toEqual(ids.filter((_, c) => c !== 4).sort());
    expect(tr.stillSince(-1).still).toEqual([]);
  });

  it("スロットのラベルが変わっても、外枠が同じなら同じ面（傾けて正面が上に入れ替わった）", () => {
    const tr = new OrientTracker();
    let a = frame(0, [{ f: face(2, ids, [4]), quad: q }]);
    tr.push(a.reading, a.sight);
    a = frame(33, [{ f: face(0, ids, [4]), quad: q }]);
    tr.push(a.reading, a.sight);
    expect(tr.stillSince(0).still.length).toBe(8);
  });

  it("面を回した（外枠は同じでステッカーが 90° 回った）なら動いた", () => {
    const tr = new OrientTracker();
    const turned = Array.from({ length: 9 }, (_, c) => ids[CELL_MAP[3 * 9 + c]]);
    let a = frame(0, [{ f: face(2, ids), quad: q }]);
    tr.push(a.reading, a.sight);
    a = frame(33, [{ f: face(2, turned), quad: q }]);
    tr.push(a.reading, a.sight);
    expect(tr.stillSince(0).still).toEqual([]);
  });

  it("格子の向きの付け直し（外枠の隅が 1 つずれた）はマスの対応に入れる", () => {
    const tr = new OrientTracker();
    // 画像の上ではキューブも外枠も同じ所。格子の 0 行目の辺だけが変わった: 新しい格子の隅 (k + 1) に前の隅 k
    const relabeled = new Array<number>(9);
    for (let c = 0; c < 9; c++) relabeled[CELL_MAP[9 + c]] = ids[c];
    let a = frame(0, [{ f: face(2, ids), quad: q }]);
    tr.push(a.reading, a.sight);
    a = frame(33, [{ f: face(2, relabeled), quad: turnQuad(q, 1) }]);
    tr.push(a.reading, a.sight);
    expect(tr.stillSince(0).still.length).toBe(8);
  });

  it("離れすぎたフレームとは突き合わせない", () => {
    const tr = new OrientTracker({ maxGapMs: 300 });
    let a = frame(0, [{ f: face(2, ids), quad: q }]);
    tr.push(a.reading, a.sight);
    a = frame(500, [{ f: face(2, ids), quad: q }]);
    tr.push(a.reading, a.sight);
    expect(tr.stillSince(0).still).toEqual([]);
  });
});

describe("trackedOrient（ライブのデコーダ）", () => {
  const opts = (on: boolean) => ({
    observer: { ...ARUCO_OBSERVER, ...LIVE_OBSERVER },
    decoder: { priorWeight: 0, confirmMargin: 1, deepHyps: 4, bridgeDepth: 5, ...(on ? { trackedOrient: LIVE_TRACKED_ORIENT } : {}) },
    orient: on,
  });

  it("傾けて面の割り当てが入れ替わっただけなら、手を足さずに持ち替える（無料に近い）", () => {
    // 正面と上が見えている。前に傾けると上の面が正面に、正面だった面が下に入る（画像の上の位置は同じ）
    const s = solvedState();
    const o1 = 0;
    const o2 = rotateOrientation(o1, "x", 3);
    const up = idsAt(s, o1, 0);
    const front = idsAt(s, o1, 2);
    expect(idsAt(s, o2, 2)).toEqual(up);
    expect(idsAt(s, o2, 3)).toEqual(front);
    const qUp = square(100, 40, 90);
    const qFront = square(100, 130, 90);
    for (const on of [false, true]) {
      const e = new TrackerEngine(s, ARUCO_REFS, opts(on), [o1]);
      const a = frame(0, [{ f: face(0, up, [4]), quad: qUp }, { f: face(2, front, [4]), quad: qFront }]);
      e.push(a.reading, a.sight);
      const b = frame(33, [{ f: face(2, up, [4]), quad: qUp }, { f: face(3, front, [4]), quad: qFront }]);
      const u = e.push(b.reading, b.sight)!;
      expect(u.moves).toEqual([]);
      expect(u.orient).toBe(o2);
      // 持ち替えのコスト: 前 1.5・後 freeCost
      expect(e.decoder.costOffset).toBeCloseTo(on ? LIVE_TRACKED_ORIENT.freeCost : 1.5, 5);
    }
  });

  it("動いていないステッカーを動かす層の手にはコストを足す（手は禁じない）", () => {
    // 正面が見えていて、上の段が見えないまま U を回した（正面の上の段が変わる）。正面の下 2 段は同じマスに残っている
    const s = solvedState();
    const t = applyMove(s, moveIndex("U"));
    const before = idsAt(s, 0, 2);
    const after = idsAt(t, 0, 2);
    const q = square(100, 100, 90);
    const e = new TrackerEngine(s, ARUCO_REFS, opts(true), [0]);
    const a = frame(0, [{ f: face(2, before), quad: q }]);
    e.push(a.reading, a.sight);
    const b = frame(33, [{ f: face(2, after), quad: q }]);
    const u = e.push(b.reading, b.sight)!;
    expect(u.moves.map((m) => m.move)).toEqual([moveIndex("U")]);
    // U の層には正面の上の段しかない: 動いていないステッカー（下 2 段）は U の層にないので、U にはコストを足さない
    expect(e.decoder.costOffset).toBeCloseTo(1, 5);
  });
});
