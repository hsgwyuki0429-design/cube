import { describe, expect, it } from "vitest";
import { StillSkipper } from "../src/vision/motion";

const frame = (v: number, w = 64, h = 64) => ({ data: new Uint8ClampedArray(w * h * 4).fill(v), width: w, height: h });

describe("still-frame skipper", () => {
  it("skips frames while nothing moves and processes the held frame when motion starts", () => {
    const s = new StillSkipper();
    const t = (k: number) => k * 16;
    expect(s.next(frame(100), t(0)).length).toBe(1); // 最初
    expect(s.next(frame(100), t(1)).length).toBe(1); // 止まった最初の 1 枚
    expect(s.next(frame(100), t(2)).length).toBe(0);
    const moved = s.next(frame(140), t(3));
    // 動き出した: 直前の静止フレームと今のフレーム
    expect(moved.map((x) => x.t)).toEqual([t(2), t(3)]);
    // 動いている間は全部
    expect(s.next(frame(180), t(4)).length).toBe(1);
    // 止まった最初の 1 枚は処理し、その次から飛ばす
    expect(s.next(frame(180), t(5)).length).toBe(1);
    expect(s.next(frame(180), t(6)).length).toBe(0);
  });

  it("still processes one frame every 200 ms while static", () => {
    const s = new StillSkipper();
    let n = 0;
    for (let k = 0; k < 60; k++) n += s.next(frame(100), k * 16).length;
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(6);
  });

  it("ゆっくり動き出したときは、動いたと分かる前の数フレームも処理する（回し始めの時刻のため）", () => {
    const s = new StillSkipper();
    const t = (k: number) => k * 8;
    for (let k = 0; k < 10; k++) s.next(frame(100), t(k));
    s.next(frame(101), t(10)); // 差が小さく「止まっている」
    s.next(frame(102), t(11));
    const moved = s.next(frame(140), t(12));
    expect(moved.map((x) => x.t)).toEqual([t(8), t(9), t(10), t(11), t(12)]);
  });
});
