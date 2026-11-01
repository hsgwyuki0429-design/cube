// 解析中に落ちたときの備え（src/app/crashGuard.ts）: 印が残ったまま読み込まれたら、落ちた段階を返して解析を 1 段軽くする
import { beforeEach, describe, expect, it } from "vitest";
import { checkLastRun, markPhase, resetSafeLevel, safeLevel } from "../src/app/crashGuard";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

describe("crashGuard", () => {
  beforeEach(() => store.clear());

  it("finds the phase where the app died and lightens the analysis step by step", () => {
    markPhase("decode");
    expect(checkLastRun()).toEqual({ phase: "decode", level: 1 });
    expect(safeLevel()).toBe(1);
    // 印は読んだら消える（もう一度読み込んでも数えない）
    expect(checkLastRun()).toBeNull();
    markPhase("timing");
    expect(checkLastRun()?.level).toBe(2);
    markPhase("saving");
    expect(checkLastRun()?.level).toBe(2);
    resetSafeLevel();
    expect(safeLevel()).toBe(0);
  });

  it("does not count a run that finished or an old mark", () => {
    markPhase("finishing");
    markPhase(null);
    expect(checkLastRun()).toBeNull();
    markPhase("finishing");
    expect(checkLastRun(Date.now() + 60 * 60 * 1000)).toBeNull();
    expect(safeLevel()).toBe(0);
  });
});
