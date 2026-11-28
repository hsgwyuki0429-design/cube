import { describe, expect, it } from "vitest";
import { LIVE_REST_GUARD_MS, LiveRest } from "../src/app/liveRest";

describe("止めた後のライブの休み", () => {
  it("解析が終わるまで休み、時間では切らない", () => {
    const r = new LiveRest();
    r.setPhase("done", 0);
    const s = r.start(100);
    expect(r.resting).toBe(true);
    r.check(60000); // 以前の 20 秒の上限は過ぎた
    expect(r.resting).toBe(true);
    r.end(61000, "result", s);
    expect(r.resting).toBe(false);
    expect(r.spans).toEqual([{ t0: 100, t1: 61000, why: "result" }]);
  });

  it("休み中に「次のソルブ」で done から離れたら解く（解析はそのまま: 後で結果が出ても何もしない）", () => {
    const r = new LiveRest();
    r.setPhase("done", 0);
    const s = r.start(1000);
    r.setPhase("preparing", 3000);
    expect(r.resting).toBe(false);
    expect(r.spans[0]).toEqual({ t0: 1000, t1: 3000, why: "next" });
    r.end(9000, "result", s);
    expect(r.spans[0].why).toBe("next");
  });

  it("done 以外では休まない（止めた後の解析が始まる前に次のソルブを押した）", () => {
    const r = new LiveRest();
    r.setPhase("done", 0);
    r.setPhase("scrambling", 500);
    expect(r.start(1200)).toBeNull();
    expect(r.resting).toBe(false);
  });

  it("前のソルブの解析の終わりで、次の休みを解かない・保険の時間で解く", () => {
    const r = new LiveRest();
    r.setPhase("done", 0);
    const a = r.start(0);
    r.setPhase("scrambling", 1000);
    r.setPhase("done", 30000);
    r.start(31000);
    r.end(32000, "result", a);
    expect(r.resting).toBe(true);
    r.check(31000 + LIVE_REST_GUARD_MS);
    expect(r.resting).toBe(false);
    expect(r.spans[1].why).toBe("guard");
  });
});
