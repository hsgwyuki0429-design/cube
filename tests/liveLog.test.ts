import { describe, expect, it } from "vitest";
import { LiveLog, mergeOptions } from "../src/track/liveLog";
import type { EngineCheckpoint } from "../src/track/engine";

const cp = (n: number): EngineCheckpoint => ({ state: [n], orients: [n], moves: n, origin: null, snaps: 0, refs: [], lastSeen: [] });
const reading = (t: number, out = true) => ({ t, faces: [], procMs: 1, ...(out ? { out: { status: "tracking", obsCost: 0, moves: 0, last: [], base: 0, view: 0 } } : {}) });

describe("ライブの記録の区切りの始まり", () => {
  it("古い読みを捨てたら、捨てた所の落ち着いた状態と設定から通し直せる", () => {
    const log = new LiveLog(10000);
    log.start([0], { decoder: { beamWidth: 32 }, snapToView: false });
    for (let t = 0; t <= 30000; t += 100) {
      if (t === 5000) log.event("options", { snapToView: true, decoder: { bridgeDepth: 5 } });
      log.add(reading(t), () => cp(t));
    }
    const seg = log.toJSON().segments[0];
    expect(seg.resume).toBeDefined();
    const t0 = seg.resume!.t;
    expect(t0).toBeLessThanOrEqual(20000);
    expect(t0).toBeGreaterThan(15000);
    expect(seg.start).toEqual([t0]);
    expect(seg.readings[0].t).toBeGreaterThan(t0);
    expect(seg.events.filter((e) => e.kind === "options")).toHaveLength(0);
    expect(seg.options).toEqual({ decoder: { beamWidth: 32, bridgeDepth: 5 }, snapToView: true });
    expect((seg as { checkpoints?: unknown }).checkpoints).toBeUndefined();
  });

  it("落ち着いた所がなければ捨てない", () => {
    const log = new LiveLog(10000);
    log.start([0], {});
    for (let t = 0; t <= 30000; t += 100) log.add(reading(t), () => null);
    const seg = log.toJSON().segments[0];
    expect(seg.readings[0].t).toBe(0);
    expect(seg.resume).toBeUndefined();
  });

  it("ソルブ中の推定を始める直前の候補は使わない", () => {
    const log = new LiveLog(1000);
    log.start([0], {});
    for (let t = 0; t <= 20000; t += 100) {
      if (t === 10000) log.event("options", { pieces: true });
      log.add(reading(t), () => cp(t));
    }
    // 10 秒の推定の始まりの前 3 秒（7〜10 秒）の候補は消える。10 秒より後の候補はそのまま
    const seg = log.toJSON().segments[0];
    expect(seg.resume!.t).toBeGreaterThan(10000);
    const log2 = new LiveLog(5000);
    log2.start([0], {});
    for (let t = 0; t <= 12000; t += 100) {
      if (t === 10000) log2.event("options", { pieces: true });
      log2.add(reading(t), () => (t < 10000 ? cp(t) : null));
    }
    expect(log2.toJSON().segments[0].resume!.t).toBeLessThan(7000);
  });

  it("track-reset（設定なし）は今の設定を引き継ぐ", () => {
    const log = new LiveLog();
    log.start([0], { snapToView: false });
    log.event("options", { snapToView: true });
    log.start([1], null);
    expect(log.toJSON().segments.at(-1)!.options).toEqual({ snapToView: true });
    expect(mergeOptions({ observer: { a: 1 } }, { observer: { b: 2 }, x: 1 })).toEqual({ observer: { a: 1, b: 2 }, x: 1 });
  });
});
