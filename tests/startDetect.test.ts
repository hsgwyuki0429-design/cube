// タイマーの開始の判定（src/app/startDetect.ts）: 見え方が ID でスクランブルの状態から確かに変わり（2 フレーム）、層が動いたのを
// フレームで見た手があるときだけ始める。持ち替え・1 フレームの読み違い・層の動きのない手（誤読を手で説明した仮説・作り変え）では始めない
import { beforeAll, describe, expect, it } from "vitest";
import { StartDetector } from "../src/app/startDetect";
import { applyMoves, parseMoves, solvedState } from "../src/cube/model";
import type { SightFrame } from "../src/track/sight";
import type { CV } from "../src/vision/image";
import { loadTestOpenCv } from "./cv";
import { EYES, at, sightOf } from "./sightRender";

let cv: CV;
const SCRAMBLE = "R U2 F' L D B2 R' U F2";
const target = applyMoves(solvedState(), parseMoves(SCRAMBLE));
let still: SightFrame; // スクランブルの状態
let rotated: SightFrame; // 持ち替えた（姿勢が違う）
let rotated2: SightFrame;
let turned: SightFrame; // R を回した
beforeAll(async () => {
  cv = await loadTestOpenCv();
  still = sightOf(cv, SCRAMBLE, 0, EYES.three);
  rotated = sightOf(cv, SCRAMBLE, 7, EYES.three);
  rotated2 = sightOf(cv, SCRAMBLE, 17, EYES.top);
  turned = sightOf(cv, `${SCRAMBLE} R`, 0, EYES.three);
}, 120000);

// 追跡の更新: 手（名前）と、その手の層が動いたのを見たか
function update(t: number, moves: string, moved: boolean[] = [], start = t - 120, inferred = false) {
  const ms = moves ? parseMoves(moves) : [];
  return {
    moves: ms.map((m, i) => ({ move: m, t0: t - 200 + i, t: t - 20 + i, orient: 0, ...(inferred ? { inferred: true } : {}) })),
    timings: ms.map((_, i) => (moved[i] !== undefined ? { start, end: t - 10, exact: true, endExact: true, moved: moved[i] } : null)),
  };
}

describe("StartDetector", () => {
  it("回した層が見えて変わり、層が動いたのを見たら始める（層の動き出しから）", () => {
    const d = new StartDetector();
    d.frame(1000, at(still, 1000), target);
    expect(d.push(update(1000, ""), 0)).toBeNull();
    d.frame(1100, at(turned, 1100), target);
    // 1 フレームだけでは始めない
    expect(d.push(update(1100, "R", [true], 1050), 0)).toBeNull();
    d.frame(1133, at(turned, 1133), target);
    expect(d.push(update(1133, "R", [true], 1050), 0, 1133)).toBe(1050);
    // 記録に残す理由: 2 フレーム変わって見え、最初の手（0）の層の動き出しから。決めたのは 83ms 後
    expect(d.why).toMatchObject({ how: "ids", frames: 2, move: 0, at: "first", lag: 83 });
    expect(d.why!.miss).toBeGreaterThanOrEqual(2);
  });

  it("持ち替え（全部の ID が一緒に動く）では、追跡が手を足しても始めない", () => {
    const d = new StartDetector();
    let t = 2000;
    for (const s of [still, rotated, rotated, rotated2, rotated2, rotated, still]) {
      d.frame(t, at(s, t), target);
      // 追跡が持ち替えを手で説明し、その層が動いたと見ても（ありえないが）、見え方は変わっていない
      expect(d.push(update(t, "R U", [true, true]), 0)).toBeNull();
      t += 33;
    }
  });

  it("1 フレームだけの読み違いでは始めない（次のフレームでスクランブルの状態に戻る）", () => {
    const d = new StartDetector();
    let t = 3000;
    for (const s of [still, turned, still, turned, still]) {
      d.frame(t, at(s, t), target);
      expect(d.push(update(t, "R", [true]), 0)).toBeNull();
      t += 33;
    }
  });

  it("見え方が変わっても、層が動いたのを見た手がなければ始めない（作り変え・誤読を手で説明した仮説・推定の手）", () => {
    const d = new StartDetector();
    let t = 4000;
    for (let i = 0; i < 6; i++, t += 33) {
      d.frame(t, at(turned, t), target);
      expect(d.push(update(t, "R"), 0)).toBeNull();
      expect(d.push(update(t, "R", [false]), 0)).toBeNull();
      expect(d.push(update(t, "R", [true], t - 100, true), 0)).toBeNull();
    }
    // 層が動いたのを見た手が来たら始める
    expect(d.push(update(t, "R", [true], t - 150), 0)).toBe(t - 150);
  });

  it("スクランブルを案内と違えて回していた（最初から変わって見える）ときは、変わり始めではなく層の動きで始める", () => {
    const d = new StartDetector();
    let t = 5000;
    for (let i = 0; i < 60; i++, t += 33) {
      d.frame(t, at(turned, t), target);
      expect(d.push(update(t, ""), 0)).toBeNull();
    }
    expect(d.push(update(t, "U", [true], t - 140), 0)).toBe(t - 140);
  });

  it("最初の手が読み違いの手（層の動き出しが分からない）なら、後の手の動き出しまで遡る", () => {
    const d = new StartDetector();
    const t = 7000;
    for (let i = 0; i < 2; i++) d.frame(t + i * 33, at(turned, t + i * 33), target);
    // 最初の手（t0 が何秒も前）は動き出しが分からず、2 手目の層が動き出したのは変わり始めたフレームの 450ms 前（変わったのに
    // 気づくのが遅れた）。最初の手の t0 からは 300ms までしか遡らないが、動き出しが分かる手なら 600ms まで
    const u = update(t + 33, "D R", [false, true], t - 450);
    u.moves[0].t0 = t - 5000;
    u.timings[0] = null;
    expect(d.push(u, 0)).toBe(t - 450);
    expect(d.why).toMatchObject({ move: 1, at: "exact" });
  });
});
