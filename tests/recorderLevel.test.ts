// 録画の圧縮の強さを端末に合わせる（src/vision/recorder.ts の「端末に合わせる」）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BITRATES, lowerRecordBitrate } from "../src/vision/recorder";

const KEY = "cubevision.recordBitrate";
let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("録画の圧縮の強さ", () => {
  it("5Mbps から始め、落ちたら 1 段ずつ下げて、いちばん下で止まる", () => {
    expect(BITRATES[0]).toBe(5_000_000);
    lowerRecordBitrate();
    expect(JSON.parse(store.get(KEY)!).level).toBe(Math.min(1, BITRATES.length - 1));
    for (let i = 0; i < 5; i++) lowerRecordBitrate();
    expect(JSON.parse(store.get(KEY)!).level).toBe(BITRATES.length - 1);
  });
  it("壊れた値は最初の段として扱う", () => {
    store.set(KEY, "{\"level\":99}");
    lowerRecordBitrate();
    expect(JSON.parse(store.get(KEY)!).level).toBe(Math.min(1, BITRATES.length - 1));
  });
});
