import { describe, expect, it } from "vitest";
import { D, applyMoves, invertMoves, parseMoves, rotateOrientation, solvedState } from "../src/cube/model";
import { type StatsMove, regripRotation, solveStats, statsInputFromSolve } from "../src/cube/solveStats";

const SUNE = "R U R' U R U2 R'";
const TPERM = "R U R' U' R' F R2 U' R' U' R U R' F'";

// 手順 alg を、揃った状態から逆に回した状態から回す。gap[i] = 手 i と手 i + 1 の間（既定 50ms）、1 手 100ms
function record(alg: string, opt: { gap?: Record<number, number>; orient?: (i: number) => number; inferred?: number[]; notExact?: number[] } = {}) {
  const ms = parseMoves(alg.replace(/\|/g, " "));
  const moves: StatsMove[] = [];
  let t = 1000;
  ms.forEach((move, i) => {
    moves.push({
      move,
      start: t,
      end: t + 100,
      orient: opt.orient?.(i) ?? 0,
      ...(opt.inferred?.includes(i) ? { inferred: true } : {}),
      exact: !opt.notExact?.includes(i),
    });
    t += 100 + (opt.gap?.[i] ?? 50);
  });
  return { startState: applyMoves(solvedState(), invertMoves(ms)), moves };
}

// クロス 3 手 | F2L のペア 4 組 | OLL（Sune）| PLL（T-perm）。D が底面
const MAIN = `F2 R2 L2 | U R U R' | R' U' R | U' L' U L | L U L' | ${SUNE} | ${TPERM}`;
const OY = rotateOrientation(0, "y");
const OYX = rotateOrientation(OY, "x");

describe("solveStats", () => {
  const rec = record(MAIN, {
    gap: { 2: 800, 8: 400, 13: 350, 16: 600, 23: 200 },
    orient: (i) => (i < 2 ? 0 : i < 10 ? OY : OYX),
    inferred: [14],
  });
  const st = solveStats(rec);

  it("手数・目標との差", () => {
    expect(st.solved).toBe(true);
    expect(st.htm).toBe(38);
    // 半回転は R2 L2 F2 U2 R2 = 5 手 → QTM は 38 + 5
    expect(st.qtm).toBe(43);
    expect(st.overTarget).toBe(38 - 50);
    expect(solveStats(rec, { targetMoves: 40 }).overTarget).toBe(-2);
    expect(st.inferred).toBe(1);
  });

  it("フェーズ: クロス・F2L 1〜4・OLL・PLL の区切りと時間・TPS・初動タイム", () => {
    expect(st.crossFace).toBe(D);
    const p = st.phases!;
    expect(p.map((x) => [x.name, x.from, x.to])).toEqual([
      ["クロス", 0, 3],
      ["F2L 1", 3, 7],
      ["F2L 2", 7, 10],
      ["F2L 3", 10, 14],
      ["F2L 4", 14, 17],
      ["OLL", 17, 24],
      ["PLL", 24, 38],
    ]);
    // クロス: 1000〜（3 手目の回し終わり）1000 + 150 + 150 + 100 = 1400
    expect(p[0].ms).toBe(400);
    expect(p[0].execMs).toBe(400);
    // F2L 1: クロスの回し終わり 1400 → 止まり 800 → 4 手（100 + 50 + 100 + 50 + 100 + 50 + 100 = 550）= 1350
    expect(p[1].ms).toBe(1350);
    expect(p[1].execMs).toBe(550);
    expect(p[1].tps).toBeCloseTo(4 / 1.35, 5);
    // 推定の手（14 = F2L 4 の最初）を含む区間は不確か
    expect(p[4].inferred).toBe(1);
    expect(p[4].uncertain).toBe(true);
    expect(p[1].uncertain).toBe(false);
    // 初動タイム = 回し始め〜F2L 1 個目が入った手（7 手目）の回し終わり
    expect(st.firstPairMs).toBe(400 + 1350);
    expect(p.reduce((s, x) => s + x.ms, 0)).toBe(st.ms);
  });

  it("止まった所: しきい値以上の一覧・合計・つなぎ目・推定の手の前後は不確か", () => {
    expect(st.pauses.map((x) => [x.after, x.ms, x.phase, x.boundary, x.uncertain])).toEqual([
      [2, 800, "F2L 1", "クロス→F2L 1", false],
      [8, 400, "F2L 2", null, false],
      [13, 350, "F2L 4", "F2L 3→F2L 4", true],
      [16, 600, "OLL", "F2L 4→OLL", false],
    ]);
    expect(st.pauseTotalMs).toBe(800 + 400 + 350 + 600);
    expect(st.pauseSureMs).toBe(800 + 400 + 600);
    // つなぎ目はしきい値によらず全部
    expect(st.gaps.map((g) => [g.name, g.ms, g.uncertain])).toEqual([
      ["クロス→F2L 1", 800, false],
      ["F2L 1→F2L 2", 50, false],
      ["F2L 2→F2L 3", 50, false],
      ["F2L 3→F2L 4", 350, true],
      ["F2L 4→OLL", 600, false],
      ["OLL→PLL", 200, false],
    ]);
    expect(solveStats(rec, { pauseMs: 500 }).pauses.map((x) => x.after)).toEqual([2, 16]);
  });

  it("時刻をフレームから決められなかった手の前後も不確か", () => {
    const r = solveStats(record(MAIN, { gap: { 2: 800 }, notExact: [3] }));
    expect(r.pauses[0].uncertain).toBe(true);
    expect(r.notExact).toBe(1);
    expect(r.phases![1].uncertain).toBe(true);
  });

  it("持ち替え: 回数・回転・クロス中の回数", () => {
    expect(st.regrips.map((r) => [r.after, r.rotation, r.axes, r.phase])).toEqual([
      [1, "y", ["y"], "クロス"],
      [9, "x", ["x"], "F2L 3"],
    ]);
    expect(st.regripsInCross).toBe(1);
    expect(st.regripsNet).toBe(2);
    // 傾けて 1.5 秒以内に戻した 2 回は peek（持ち替えの数から除く）
    const OX = rotateOrientation(0, "x");
    const p = solveStats(record(MAIN, { orient: (i) => (i === 20 || i === 21 ? OX : 0) }));
    expect(p.regrips.map((r) => [r.after, r.rotation, r.peek])).toEqual([
      [19, "x", true],
      [21, "x'", true],
    ]);
    expect(p.regripsNet).toBe(0);
    expect(solveStats(record(MAIN, { orient: (i) => (i === 20 || i === 21 ? OX : 0) }), { peekMs: 200 }).regripsNet).toBe(2);
    expect(st.cross).toEqual({ moves: 3, within8: true, regrips: 1, noRegrip: false });
    // 自分視点（カメラフレームを y2 回した）では x が x' になる。y はそのまま
    expect(solveStats(rec, { selfView: true }).regrips.map((r) => r.rotation)).toEqual(["y", "x'"]);
    expect(regripRotation(0, rotateOrientation(rotateOrientation(0, "x"), "y")).name).toBe("x y");
    expect(regripRotation(5, 5).name).toBe("");
  });

  it("無駄な回転: 同じ面の手が続いた所（推定の手を含めば不確か）", () => {
    expect(st.waste.map((w) => [w.from, w.moves.join(" "), w.net, w.saved, w.kind, w.uncertain])).toEqual([
      [6, "R' R'", "R2", 1, "repeat", false],
      [13, "L L", "L2", 1, "repeat", true],
      [23, "R' R", "", 2, "repeat", false],
    ]);
    expect(st.wasteMoves).toBe(4);
    expect(st.notes.some((x) => x.includes("まとめた後"))).toBe(true);
  });

  it("TPS の推移: 1 秒ごと・手ごとの移動平均", () => {
    // すき間なく 100ms ずつ 12 手: 最初の 1 秒に 9 手が回し終わり、次の 1 秒に 3 手（最後の手の回し終わりは最後の 1 秒に入れる）
    const ms = parseMoves("R U R' U' R U R' U' R U R' U'");
    const r = solveStats({ startState: applyMoves(solvedState(), invertMoves(ms)), moves: ms.map((move, i) => ({ move, start: i * 100, end: i * 100 + 100 })) });
    expect(r.tpsPerSecond.map((b) => b.moves)).toEqual([9, 3]);
    expect(r.tpsRolling).toHaveLength(8);
    expect(r.tpsRolling[0].tps).toBeCloseTo(10, 5);
    expect(r.tps).toBeCloseTo(10, 5);
    // 揃いに着かなければフェーズは出さない
    const u = solveStats({ startState: solvedState(), moves: [{ move: 3, start: 0, end: 100 }] });
    expect(u.solved).toBe(false);
    expect(u.phases).toBeNull();
    expect(u.gaps).toEqual([]);
  });

  it("X クロス: クロスの最後の手でペアも入った・前から入っていた", () => {
    const a = solveStats(record(`R U' R' D | ${SUNE} | ${TPERM}`));
    expect(a.xcross).toEqual({ done: true, slots: expect.any(Array), withLastCrossMove: true });
    expect(a.gaps[0]).toMatchObject({ name: "クロス→F2L 1", ms: null, merged: true });
    // F2 でクロスが揃ったとき、後ろの 2 組（F に触れない BR・BL）はもう入っていた。F2 で入ったペアはない
    const b = solveStats(record(`F2 | R U R' | L' U L | ${SUNE} | ${TPERM}`));
    expect(b.xcross?.done).toBe(true);
    expect(b.xcross?.slots).toHaveLength(2);
    expect(b.xcross?.withLastCrossMove).toBe(false);
    expect(b.phases!.map((p) => p.moves)).toEqual([1, 0, 0, 3, 3, 7, 14]);
    expect(st.xcross).toEqual({ done: false, slots: [], withLastCrossMove: false });
  });

  it("クロスの最後の手と F2L の最初の手が同じ面", () => {
    const r = solveStats(record(`R2 F | F' U' F | ${SUNE} | ${TPERM}`));
    expect(r.phases![0].to).toBe(2);
    expect(r.waste[0]).toMatchObject({ from: 1, moves: ["F", "F'"], net: "", saved: 2, kind: "cross-f2l" });
  });

  it("止めた後の手は数えない", () => {
    const base = record(MAIN);
    const last = base.moves[base.moves.length - 1];
    const extra = parseMoves("U U'").map((move, i) => ({ move, start: last.end + 300 + i * 200, end: last.end + 400 + i * 200 }));
    const r = solveStats({ ...base, moves: [...base.moves, ...extra], stopAt: last.end + 100, cutBefore: 3 });
    expect(r.excludedAfterStop).toBe(2);
    expect(r.cutBefore).toBe(3);
    expect(r.htm).toBe(38);
    expect(r.solved).toBe(true);
    // 止めた時刻を渡さなければ数える（揃いの後の U U' は無駄な回転）
    const all = solveStats({ ...base, moves: [...base.moves, ...extra] });
    expect(all.htm).toBe(40);
    expect(all.waste.at(-1)).toMatchObject({ moves: ["U", "U'"], saved: 2 });
  });

  it("記録（Solve）から", () => {
    const scramble = "R U R' U'";
    const r = solveStats(
      statsInputFromSolve({
        scramble,
        moves: [
          { m: "U", r: "U", s: 0, t: 100, o: 0 },
          { m: "R", r: "R", s: 500, t: 600, o: 0, inferred: true },
          { m: "U'", r: "U'", s: 650, t: 750, o: OY },
          { m: "R'", r: "R'", t: 900, o: OY },
        ] as never,
        edges: { stop: { cut: 1 } },
      }),
    );
    expect(r.solved).toBe(true);
    expect(r.ms).toBe(900);
    expect(r.inferred).toBe(1);
    expect(r.notExact).toBe(1); // 回し始めが無い手
    expect(r.cutBefore).toBe(1);
    expect(r.pauses).toEqual([expect.objectContaining({ after: 0, ms: 400, uncertain: true })]);
    expect(r.regrips[0]).toMatchObject({ after: 1, rotation: "y", uncertain: true });
  });
});
