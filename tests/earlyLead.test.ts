// インスペクション中に離れて残った最初の手をタイムの端にしない（src/vision/refine.ts の isolatedLead）
import { beforeAll, describe, expect, it } from "vitest";
import { STICKERS, designOf } from "../src/aruco/design";
import { ARUCO_REFS } from "../src/aruco/palette";
import { type Vec3, applyMoves, inverseMove, parseMoves, solvedState } from "../src/cube/model";
import { ARUCO_OBSERVER } from "../src/track/observer";
import type { CV } from "../src/vision/image";
import { EARLY_GAP_MS, Refiner, isolatedLead } from "../src/vision/refine";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "./arucoCube";
import { loadTestOpenCv } from "./cv";

describe("isolatedLead", () => {
  const mv = (start: number, end: number) => ({ start, end });
  it("回し始めの判定より前に回し終わり、その後長く止まった手を数える", () => {
    // 12.08 秒の手（判定 12.79 秒）の後、13.23 秒まで止まっている
    expect(isolatedLead([mv(12000, 12080), mv(13233, 13316), mv(13375, 13575)], 12790)).toBe(1);
    // 判定の前から続けて回している（リアルタイムが最初の手を取りこぼした）: 端にしてよい
    expect(isolatedLead([mv(12000, 12080), mv(12250, 12400), mv(12500, 12650)], 12790)).toBe(0);
    // 判定より後の手は数えない
    expect(isolatedLead([mv(13000, 13100), mv(14000, 14100)], 12790)).toBe(0);
    // 判定より前に離れた手が 2 つ
    expect(isolatedLead([mv(10000, 10100), mv(11000, 11080), mv(12900, 13000)], 12790)).toBe(2);
    // インスペクションの終わりが分からなければ数えない
    expect(isolatedLead([mv(12000, 12080), mv(13233, 13316)], Number.NEGATIVE_INFINITY)).toBe(0);
    expect(EARLY_GAP_MS).toBeGreaterThan(300);
  });
});

describe("精密解析（Refiner）: インスペクション中の手でタイムを始めない", () => {
  let cv: CV;
  beforeAll(async () => {
    cv = await loadTestOpenCv();
  }, 120000);
  // 案内と 6 手違う状態から回した（前向きが最初の観測でその違いを確定の手として説明する）。インスペクション 1.5 秒の後、完成まで回す
  it("最初の観測で説明した手（インスペクション中）は inferred にし、タイムは回し始めから", () => {
    const actualScramble = parseMoves("R U F' D");
    const given = applyMoves(solvedState(), parseMoves("R U F' D L2 B R' D2 F U2"));
    const solve = [...actualScramble].reverse().map(inverseMove);
    const refiner = new Refiner(cv, { state: Array.from(given), refs: ARUCO_REFS, from: 0, to: Infinity, engine: { observer: ARUCO_OBSERVER, decoder: { beamWidth: 32, maxMovesPerStep: 3, rotationCost: 1.5 } }, pipeline: { ...STICKERS } });
    const inspectMs = 1500;
    // リアルタイムの回し始めの判定（最初の手の 0.5 秒前から全部のフレームを解析する: controller の SOLVE_LEAD_MS）
    refiner.setInspectUntil(inspectMs - 500);
    let st = solvedStickers();
    for (const m of actualScramble) st = applyMoveStickers(st, m);
    const EYE: Vec3 = [2.4, 2.4, 5.5];
    const period = 420;
    const turnMs = 170;
    let done = 0;
    for (let t = 0; t <= inspectMs + solve.length * period + 500; t += 1000 / 30) {
      while (done < solve.length && t >= inspectMs + done * period + turnMs) st = applyMoveStickers(st, solve[done++]);
      const s = inspectMs + done * period;
      const turning = done < solve.length && t >= s;
      const img = renderArucoCube(cv, { width: 960, height: 720, stickers: st, orient: 0, eye: [EYE[0] + 0.15 * Math.sin(t / 250), EYE[1], EYE[2]], turn: turning ? { move: solve[done], fraction: (t - s) / turnMs, spread: 0.15 } : undefined, noise: 2, seed: Math.round(t) + 1, scheme: "unique54", design: designOf(STICKERS.arucoDesign) });
      refiner.push(img, t);
    }
    const r = refiner.result(solvedState());
    expect(r.solved).toBe(true);
    // タイムは回し始め（1.5 秒）から。インスペクションの始まり（0 秒）の手からではない
    expect(r.start).not.toBeNull();
    expect(r.start!).toBeGreaterThan(inspectMs - 200);
    // インスペクション中の手は inferred（確定にしない）
    for (const m of r.moves) if (m.end < inspectMs - 500) expect(m.inferred).toBe(true);
  }, 300000);
});
