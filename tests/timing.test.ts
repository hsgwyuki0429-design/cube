// 手の時刻（src/track/timing.ts）: ArUco のフレーム（マーカーの本体の格子からのずれ shift がある）では、色ではなくマーカーの位置で
// 層の動きを見る。色（代表色）は層が回っても変わらないフレームで、回し始め・回し終わりをマーカーから決める
import { describe, expect, it } from "vitest";
import { ARUCO_REFS } from "../src/aruco/palette";
import { DEFAULT_TIMING, type LoggedFrame, cellInLayer, moveTiming } from "../src/track/timing";
import type { Lab } from "../src/vision/color";

const R = 3; // R（時計回り）
const DT = 1000 / 30;

// 正面（slot 2）と上（slot 0）の 2 面。層 R の側面のマスは、moving(t) のとき読めず（ぶれ）、after(t) のとき回した後のステッカー
function frames(moving: (t: number) => boolean, after: (t: number) => boolean, jitter = 0): LoggedFrame[] {
  const out: LoggedFrame[] = [];
  for (let i = 0; i <= 15; i++) {
    const t = i * DT;
    out.push({
      t,
      faces: [0, 2].map((slot) => {
        const layer = Array.from({ length: 9 }, (_, cell) => cellInLayer(0, slot, cell, 1));
        const lost = (cell: number) => layer[cell] && moving(t);
        return {
          slot,
          // 色は揃った面の代表色のまま（色で補った・ID なし追跡で引き継いだマスは、回している途中も前の色）
          labs: Array.from({ length: 9 }, () => [...ARUCO_REFS[slot === 0 ? 0 : 2]] as Lab),
          valid: new Array(9).fill(true),
          spread: new Array(9).fill(0),
          masked: new Array(9).fill(false),
          shift: Array.from({ length: 9 }, (_, cell) => (lost(cell) ? null : ([jitter * Math.sin(i * 7 + cell), jitter * Math.cos(i * 5 + cell)] as [number, number]))),
          ids: Array.from({ length: 9 }, (_, cell) => (lost(cell) ? -1 : (slot === 0 ? 0 : 18) + cell + (layer[cell] && after(t) ? 100 : 0))),
        };
      }),
    });
  }
  return out;
}

describe("手の時刻（マーカーの位置）", () => {
  // 回転: 200〜330ms（7・8・9 枚目で層が読めない）、後ろは回した後のステッカー
  const fr = frames(
    (t) => t > 210 && t < 320,
    (t) => t > 320,
  );

  it("色が変わらなくても、層のマーカーが読めなくなったフレームを回し始めにする", () => {
    const tm = moveTiming(fr, { move: R, t0: 200, t: 367, orient: 0 }, { ...DEFAULT_TIMING, refs: ARUCO_REFS });
    expect(tm.exact).toBe(true);
    expect(tm.start).toBeCloseTo((6 * DT + 7 * DT) / 2, 0);
    expect(tm.endExact).toBe(true);
    expect(tm.end).toBeCloseTo((9 * DT + 10 * DT) / 2, 0);
  });

  it("t0 が回し終わりより後でも、回した後の静止を回し始めの前と取り違えない", () => {
    const tm = moveTiming(fr, { move: R, t0: 400, t: 433, orient: 0 }, { ...DEFAULT_TIMING, refs: ARUCO_REFS });
    expect(tm.start).toBeCloseTo((6 * DT + 7 * DT) / 2, 0);
  });

  it("止まっている間のマーカーの位置の揺れは動きとみなさない", () => {
    const noisy = frames(
      (t) => t > 210 && t < 320,
      (t) => t > 320,
      0.06,
    );
    const tm = moveTiming(noisy, { move: R, t0: 200, t: 367, orient: 0 }, { ...DEFAULT_TIMING, refs: ARUCO_REFS });
    expect(tm.start).toBeCloseTo((6 * DT + 7 * DT) / 2, 0);
  });

  it("層がずっと見えなければ、時刻をフレームから決められない（exact でない）", () => {
    const hidden = fr.map((f) => ({ ...f, faces: f.faces.map((x) => ({ ...x, masked: (x.masked ?? []).map((_, cell) => cellInLayer(0, x.slot, cell, 1)) })) }));
    const tm = moveTiming(hidden, { move: R, t0: 200, t: 367, orient: 0 }, { ...DEFAULT_TIMING, refs: ARUCO_REFS });
    expect(tm.exact).toBe(false);
    expect(tm.endExact).toBe(false);
  });
});
