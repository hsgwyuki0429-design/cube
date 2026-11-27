import { describe, expect, it } from "vitest";
import { type AdviceSample, CaptureAdvisor, adviceAfterSolve, adviceNow } from "../src/app/captureAdvice";
import { viewMetrics } from "../src/vision/captureMetrics";

// 正面の面だけ（辺 e・真ん中 cx, cy の画素）と、もう 1 面（two）を写した見え方
const face = (slot: number, x0: number, y0: number, e: number, k = 1) => ({ slot, ids: new Array(9).fill(0), rot: new Array(9).fill(0), quad: [x0, y0, x0 + e, y0, x0 + e, y0 + e * k, x0, y0 + e * k] });
const sample = (t: number, o: { e?: number; cx?: number; cy?: number; two?: boolean; light?: number } = {}): AdviceSample => {
  const e = o.e ?? 300;
  const x0 = 640 + (o.cx ?? 0) * 1280 - e / 2;
  const y0 = 360 + (o.cy ?? 0) * 720 - e / 2;
  const faces = [face(2, x0, y0, e)];
  if (o.two ?? true) faces.push(face(0, x0, y0 - e * 0.5, e, 0.5));
  return { t, view: viewMetrics({ t, faces }, 1280, 720), light: { cube: o.light ?? 140, frame: o.light ?? 140 } };
};
const run = (adv: CaptureAdvisor, from: number, to: number, o: Parameters<typeof sample>[1], quiet = false) => {
  let key = null;
  for (let t = from; t < to; t += 250) {
    adv.push(sample(t, o));
    key = adv.update(t, quiet);
  }
  return key;
};

describe("撮り方の案内", () => {
  it("見え方ごとに、いちばん効く 1 つ", () => {
    const many = (o: Parameters<typeof sample>[1]) => Array.from({ length: 12 }, (_, i) => sample(i * 250, o));
    expect(adviceNow(many({}))).toBeNull();
    expect(adviceNow(many({ e: 150 }))).toBe("closer");
    expect(adviceNow(many({ light: 40 }))).toBe("light");
    expect(adviceNow(many({ cx: 0.38 }))).toBe("center");
    expect(adviceNow(many({ two: false }))).toBe("angle");
    expect(adviceNow(many({ e: 700 }))).toBe("farther");
    // 端に寄っていて小さい: 真ん中に寄せるのが先
    expect(adviceNow(many({ cx: 0.38, e: 150 }))).toBe("center");
    // キューブが写っていない
    expect(adviceNow([])).toBeNull();
  });

  it("直ったら消え、すぐには出し直さない。インスペクション・ソルブ中は出さない", () => {
    const adv = new CaptureAdvisor();
    expect(run(adv, 0, 3000, { e: 150 })).toBe("closer");
    expect(run(adv, 3000, 7000, { e: 300 })).toBeNull();
    // 直った後 20 秒は同じ注意を出さない
    expect(run(adv, 7000, 12000, { e: 150 })).toBeNull();
    expect(run(adv, 30000, 34000, { e: 150 })).toBe("closer");
    // 出さない場面
    expect(run(adv, 34000, 36000, { e: 150 }, true)).toBeNull();
  });

  it("直らなければ 10 秒で消して、しばらく出さない", () => {
    const adv = new CaptureAdvisor();
    expect(run(adv, 0, 3000, { light: 40 })).toBe("light");
    expect(run(adv, 3000, 14000, { light: 40 })).toBeNull();
    expect(run(adv, 14000, 60000, { light: 40 })).toBeNull();
    expect(run(adv, 110000, 112000, { light: 40 })).toBe("light");
  });

  it("ソルブの後: 面が組めなかったフレームが多ければ、明るく（小さければ近づける）", () => {
    expect(adviceAfterSolve({ frames: 600, noFace: 0.18, cells: 4.8, faceEdge: 360, light: 140 })).toBeNull();
    expect(adviceAfterSolve({ frames: 1300, noFace: 0.45, cells: 4.25, faceEdge: 330, light: 140 })).toBe("blurLight");
    expect(adviceAfterSolve({ frames: 800, noFace: 0.44, cells: 3.8, faceEdge: 150, light: 140 })).toBe("blurCloser");
    const adv = new CaptureAdvisor();
    adv.solveEnded({ frames: 1300, noFace: 0.45, cells: 4.25, faceEdge: 330, light: 140 }, 1000);
    expect(adv.update(2000, false)).toBe("blurLight");
    expect(adv.update(14000, false)).toBeNull();
  });
});
