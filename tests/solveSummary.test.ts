// 最後のソルブの様子の要約（src/app/solveSummary.ts）: ソルブの間の 1 秒ごとの処理・読み・録画のフレームから数え、休みは止めた時刻から
import { describe, expect, it } from "vitest";
import { summarizeSolve, summaryLines } from "../src/app/solveSummary";
import type { PerfRow } from "../src/app/perfLog";

const row = (t: number, cam: number, live: number, helper: number) => ({ t, cam, live, helper }) as unknown as PerfRow;

describe("solveSummary", () => {
  it("ソルブの間だけを数える", () => {
    const startT = 10_000;
    const endT = 14_000;
    const perf = [row(8000, 60, 60, 0), row(9000, 60, 60, 0), ...[10_000, 11_000, 12_000, 13_000].map((t) => row(t, 40, 20, 18)), row(14_000, 20, 20, 0)];
    // 読み: 4 枚に 1 枚は面なし、マスは 0・3・4・5
    const readings = Array.from({ length: 40 }, (_, i) => {
      const n = [0, 3, 4, 5][i % 4];
      return { t: startT + i * 100, faces: n ? [{ ids: Array.from({ length: 9 }, (_, c) => (c < n ? c : -1)), valid: Array(9).fill(true) }] : [], sight: { faces: n ? [{}] : [] } };
    });
    // 録画: 20ms ごと、2 か所で 2 枚・1 枚抜ける
    const rec: number[] = [];
    for (let t = startT; t <= endT; t += 20) if (t !== 11_000 && t !== 11_020 && t !== 12_000) rec.push(t);
    const s = summarizeSolve({
      solveId: "x",
      timeMs: 4000,
      stickers: "standard",
      analysis: "done",
      waitMs: 7500,
      result: { solved: true, moves: [{}, { inferred: true }, {}], method: "meet", decodeStage: "deep" },
      startT,
      endT,
      framePath: { requested: true, live: "vframe", liveWaits: 3, recorder: "vframe", recorderWaits: 0, liveNote: null, recorderNote: null },
      rests: [{ t0: 2000, t1: 3000 }, { t0: 14_100, t1: 21_500, why: "result" }],
      perf,
      readings,
      recTimesMs: rec,
      recorder: { frames: 500, dropped: 2 },
    });
    expect(s).toMatchObject({ analysis: "done", waitMs: 7500, solved: true, moves: 3, inferred: 1, method: "meet", stage: "deep", camFps: 40, liveFps: 38, liveMain: 20, liveHelper: 18, cellsMedian: 4, noFace: 0.25, liveFrames: 40 });
    expect(s.rec).toEqual({ frames: rec.length, fps: expect.any(Number), holes: 2, missing: 3, dropped: 2, total: 502 });
    // 止める前の休み（前のソルブ）は入れない
    expect(s.rests).toEqual([{ from: 0.1, to: 7.5, why: "result" }]);
    const lines = summaryLines(s).join("\n");
    expect(lines.startsWith("1 個・確定")).toBe(true);
    expect(lines).toContain("深い解き直し");
    expect(lines).toContain("推定 1/3");
    expect(lines).toContain("待ち 7.5 秒");
    expect(lines).toContain("ソルブ中 40.0fps");
    expect(lines).toContain("面なし 25%");
    expect(lines).toContain("抜け 2（3 枚）");
    expect(lines).toContain("解析の結果");
  });

  it("結果がなければ失敗か解析なし", () => {
    expect(summarizeSolve({ error: "解析が止まりました" }).analysis).toBe("error");
    expect(summarizeSolve({}).analysis).toBe("none");
    expect(summaryLines(summarizeSolve({}))[0]).toContain("解析なし");
  });
});
