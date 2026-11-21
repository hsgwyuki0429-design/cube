// 精密解析の終わりを、ライブが揃ったと判断して止めた時刻で打ち切る（src/track/stopCut.ts）
import { describe, expect, it } from "vitest";
import { applyMoves, invertMoves, parseMoves, solvedState } from "../src/cube/model";
import { STOP_AFTER_MS, STOP_BEFORE_MS, stopCut } from "../src/track/stopCut";

// 手順と時刻（回し始め・回し終わり）から、stopCut に渡す形を作る
function plan(spec: [string, number, number][]) {
  const moves = spec.map(([m]) => ({ move: parseMoves(m)[0] }));
  const at = (i: number) => ({ start: spec[i][1], end: spec[i][2] });
  return { moves, at };
}

describe("stopCut", () => {
  const solve = parseMoves("R U R' F2");
  const start = applyMoves(solvedState(), invertMoves(solve));
  const solveSpec: [string, number, number][] = [
    ["R", 1000, 1100],
    ["U", 1200, 1300],
    ["R'", 1400, 1500],
    ["F2", 1600, 1800],
  ];

  it("ふつうのソルブ（終わりの揃いが止めた時刻の近く）は打ち切らない", () => {
    const { moves, at } = plan(solveSpec);
    expect(stopCut(start, moves, 1850, at)).toBeNull();
    // ライブが少し早く（ほぼ回し終えた層を揃いと読んだ）止めた
    expect(stopCut(start, moves, 1700, at)).toBeNull();
  });

  it("揃えた後に上の層を往復させた手（IMG_5049）は外す", () => {
    const { moves, at } = plan([...solveSpec, ["U", 2100, 2200], ["U'", 2370, 2450]]);
    const cut = stopCut(start, moves, 1830, at);
    expect(cut).toEqual({ keep: 4, end: 1800 });
  });

  it("止めた時点の前後で揃いが見つからなければ打ち切らない（ライブの誤判定）", () => {
    const { moves, at } = plan([...solveSpec, ["U", 2100, 2200], ["U'", 2370, 2450]]);
    // 止めた時刻の近くでは精密解析の状態が揃っていない（ソルブの途中で止めた）
    expect(stopCut(start, moves, 1350, at)).toBeNull();
    // 揃いが止めた時刻より前すぎる
    expect(stopCut(start, moves, 1800 + STOP_BEFORE_MS + 100, at)).toBeNull();
    // 揃いが止めた時刻より後すぎる
    expect(stopCut(start, moves, 1800 - STOP_AFTER_MS - 100, at)).toBeNull();
  });

  it("止めたのが 2 回目の揃いなら、それまでの往復は残す", () => {
    const { moves, at } = plan([...solveSpec, ["U", 2100, 2200], ["U'", 2370, 2450]]);
    expect(stopCut(start, moves, 2500, at)).toBeNull();
    // 往復の後にさらに外して戻した: 2 回目の揃いで打ち切る
    const p = plan([...solveSpec, ["U", 2100, 2200], ["U'", 2370, 2450], ["R", 2800, 2900], ["R'", 3000, 3100]]);
    expect(stopCut(start, p.moves, 2500, p.at)).toEqual({ keep: 6, end: 2450 });
  });

  it("次の手も止める前に回し終えていれば、その揃いでは打ち切らない", () => {
    // 揃い（1.8 秒）の後の U を止める前（2.25 秒）に回し終え、U' は止めた後
    const { moves, at } = plan([...solveSpec, ["U", 2100, 2200], ["U'", 2370, 2450]]);
    expect(stopCut(start, moves, 2250, at)).toBeNull();
  });
});
