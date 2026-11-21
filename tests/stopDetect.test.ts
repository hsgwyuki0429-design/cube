// タイマーの停止の判定（src/app/stopDetect.ts）: 読めたステッカーが全部「揃ったときの自分の場所」にいる見え方（10 枚以上）が 0.2 秒
// 続いたら止める。PLL の途中（色は揃って見える面がある）では止めない。1 面だけ見えていても、追跡も揃いなら止める
import { beforeAll, describe, expect, it } from "vitest";
import { StopDetector } from "../src/app/stopDetect";
import { invertMoves, parseMoves } from "../src/cube/model";
import type { SightFrame } from "../src/track/sight";
import type { CV } from "../src/vision/image";
import { loadTestOpenCv } from "./cv";
import { EYES, at, sightOf } from "./sightRender";

let cv: CV;
let solved: SightFrame;
let solvedTop: SightFrame;
let solvedFront: SightFrame;
let tperm: SightFrame; // T-perm の前（上の段の 2 組が入れ替わっている）
let tpermFront: SightFrame;
let auf: SightFrame;
beforeAll(async () => {
  cv = await loadTestOpenCv();
  solved = sightOf(cv, "", 0, EYES.three);
  solvedTop = sightOf(cv, "", 5, EYES.top);
  solvedFront = sightOf(cv, "", 0, EYES.front);
  const t = invertMoves(parseMoves("R U R' U' R' F R2 U' R' U' R U R' F'"));
  tperm = sightOf(cv, t, 0, EYES.three);
  tpermFront = sightOf(cv, t, 0, EYES.front);
  auf = sightOf(cv, "U'", 0, EYES.top);
}, 120000);

function run(d: StopDetector, frames: SightFrame[], t0: number, dt = 33): (number | null)[] {
  return frames.map((s, i) => d.frame(t0 + i * dt, at(s, t0 + i * dt)));
}

describe("StopDetector", () => {
  it("揃った見え方が 0.2 秒続いたら、見え始めた時刻で止める", () => {
    const d = new StopDetector();
    const out = run(d, [tperm, solved, solved, solved, solved, solved, solved, solved, solved], 1000);
    const k = out.findIndex((x) => x !== null);
    expect(k).toBeGreaterThan(0);
    expect(1000 + k * 33 - 1033).toBeGreaterThanOrEqual(200);
    expect(out[k]).toBe(1033);
  });

  it("持ち替えながらでも（姿勢が違っても）揃いなら止める", () => {
    const d = new StopDetector();
    const out = run(d, [solved, solvedTop, solved, solvedTop, solved, solvedTop, solved, solvedTop], 1000);
    expect(out.some((x) => x !== null)).toBe(true);
  });

  it("PLL の途中・AUF では止めない（色は揃って見える面があっても）", () => {
    const d = new StopDetector();
    expect(run(d, Array(20).fill(tperm), 2000).every((x) => x === null)).toBe(true);
    expect(run(d, Array(20).fill(auf), 3000).every((x) => x === null)).toBe(true);
    // 正面だけが見えている（T-perm の前は正面の上の段が入れ替わっているので食い違う）
    expect(run(d, Array(20).fill(tpermFront), 4000).every((x) => x === null)).toBe(true);
  });

  it("揃いの間に食い違うフレームが 1 枚でもあればやり直す", () => {
    const d = new StopDetector();
    const out = run(d, [solved, solved, solved, solved, tperm, ...Array(10).fill(solved)], 5000);
    const k = out.findIndex((x) => x !== null);
    expect(out[k]).toBe(5000 + 5 * 33);
  });

  it("1 面だけ（正面）では数が足りずに止めないが、追跡も揃いなら止める", () => {
    const d = new StopDetector();
    expect(run(d, Array(20).fill(solvedFront), 6000).every((x) => x === null)).toBe(true);
    expect(d.trackedSolved(6000 + 19 * 33)).toBe(true);
    // 追跡が揃いでも、見え方が揃いと食い違えば止めない
    run(d, [tpermFront], 7000);
    expect(d.trackedSolved(7000)).toBe(false);
    // 見え方が古い（300ms より前）
    run(d, [solvedFront], 8000);
    expect(d.trackedSolved(8500)).toBe(false);
  });
});
