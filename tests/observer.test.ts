// 観測器（src/track/observer.ts）: ArUco ステッカーの設定（ARUCO_OBSERVER）では、上・横の面を少ないマスでも観測に入れ、
// 見えている面の組み合わせがフレームごとに揺れても観測を出す
import { describe, expect, it } from "vitest";
import { ARUCO_REFS } from "../src/aruco/palette";
import { ColorModel } from "../src/track/colorModel";
import { ARUCO_OBSERVER, FaceObserver } from "../src/track/observer";
import type { Lab } from "../src/vision/color";

const face = (slot: number, colors: number[]) => ({
  slot,
  labs: colors.map((c) => (c >= 0 ? ([...ARUCO_REFS[c]] as Lab) : ([0, 0, 0] as Lab))),
  valid: colors.map((c) => c >= 0),
});
const front = face(2, [2, 2, 2, 2, 2, 2, 2, 2, 2]);
const top1 = face(0, [-1, -1, -1, -1, -1, -1, -1, 0, -1]); // 上の面は 1 マスだけ

describe("ArUco の観測", () => {
  it("上の面が 1 マスだけでも観測に入れる（既定は 3 マス以上）", () => {
    const plain = new FaceObserver(new ColorModel(ARUCO_REFS), { stableFrames: 1 });
    expect(plain.push({ t: 0, faces: [front, top1] })!.faces.map((f) => f.slot)).toEqual([2]);
    const aruco = new FaceObserver(new ColorModel(ARUCO_REFS), { ...ARUCO_OBSERVER, stableFrames: 1 });
    expect(aruco.push({ t: 0, faces: [front, top1] })!.faces.map((f) => f.slot).sort()).toEqual([0, 2]);
  });

  it("見えている面の組み合わせが揺れても、どのフレームにもある面で観測を出す", () => {
    const plain = new FaceObserver(new ColorModel(ARUCO_REFS), { stableFrames: 2 });
    plain.push({ t: 0, faces: [front, top1] });
    expect(plain.push({ t: 16, faces: [front] })).toBeNull();
    const aruco = new FaceObserver(new ColorModel(ARUCO_REFS), { ...ARUCO_OBSERVER, stableFrames: 2 });
    aruco.push({ t: 0, faces: [front, top1] });
    expect(aruco.push({ t: 16, faces: [front] })!.faces.map((f) => f.slot)).toEqual([2]);
  });

  it("色が同じでも、色だけだったマスの ID が 2 つ以上読めるようになったら観測を出し直す", () => {
    const ids = [18, 19, 20, 21, 22, 23, 24, 25, 26];
    const colorOnly = { ...front, ids: ids.map((id, i) => (i < 3 ? -1 : id)), weight: [0.5, 0.5, 0.5, 1, 1, 1, 1, 1, 1] };
    const o = new FaceObserver(new ColorModel(ARUCO_REFS), { ...ARUCO_OBSERVER, stableFrames: 1 });
    expect(o.push({ t: 0, faces: [colorOnly] })).not.toBeNull();
    expect(o.push({ t: 33, faces: [colorOnly] })).toBeNull();
    expect(o.push({ t: 67, faces: [{ ...colorOnly, ids: ids.map((id, i) => (i < 1 ? -1 : id)) }] })!.faces[0].ids![1]).toBe(19);
    expect(o.push({ t: 100, faces: [{ ...front, ids }] })).toBeNull(); // 1 つだけ増えた
  });
});
