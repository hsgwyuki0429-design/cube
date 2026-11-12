// 解析中に落ちたときの備え（src/app/crashGuard.ts）: 印が残ったまま読み込まれたら、落ちた段階を返す
import { beforeEach, describe, expect, it } from "vitest";
import { checkLastRun, markPhase } from "../src/app/crashGuard";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

describe("crashGuard", () => {
  beforeEach(() => store.clear());

  it("finds the phase where the app died", () => {
    markPhase("decode");
    expect(checkLastRun()).toEqual({ phase: "decode" });
    // 印は読んだら消える（もう一度読み込んでも数えない）
    expect(checkLastRun()).toBeNull();
  });

  it("does not count a run that finished or an old mark", () => {
    markPhase("finishing");
    markPhase(null);
    expect(checkLastRun()).toBeNull();
    markPhase("finishing");
    expect(checkLastRun(Date.now() + 60 * 60 * 1000)).toBeNull();
  });

  it("clears the old analysis level that lightened the analysis", () => {
    store.set("cubevision.safeAnalysis", "2");
    checkLastRun();
    expect(store.has("cubevision.safeAnalysis")).toBe(false);
  });
});
