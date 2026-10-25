import { describe, expect, it } from "vitest";
import { applyMoves, parseMoves, solvedState } from "../src/cube/model";
import { TrackerEngine } from "../src/track/engine";
import { observe, rng } from "./sim";

describe("rebasing the live tracker onto the precise analysis", () => {
  it("keeps the earlier moves, takes the analysis' moves, and replays later observations", () => {
    const refs = Array.from({ length: 6 }, (_, i) => [50 + i, 0, 0] as [number, number, number]);
    const engine = new TrackerEngine(solvedState(), refs, { keepObservations: true });
    const rnd = rng(3);
    const noise = { misread: 0, hidden: 0, mismatchCost: 1.5 };
    const seq = parseMoves("F R U R' U'");
    let state = solvedState();
    const truth: { t: number; state: Uint8Array }[] = [];
    seq.forEach((m, i) => {
      state = applyMoves(state, [m]);
      truth.push({ t: (i + 1) * 300, state });
      const obs = observe(state, 0, [2, 0, 1], (i + 1) * 300, (i + 1) * 300 - 250, rnd, noise);
      engine.observationLog.push(obs);
      engine.observe(obs);
    });
    expect(engine.decoder.bestMoves().map((m) => m.move)).toEqual(seq);
    // 解析: F の後（keep = 1）から R U までを解き直した（時刻 900 まで）
    const moves = parseMoves("R U").map((move, k) => ({ move, t: 600 + k * 300, t0: 450 + k * 300, orient: 0 }));
    const u = engine.rebase(truth[2].state, 0, moves, 900, 1);
    expect(u.moves.map((m) => m.move)).toEqual(seq);
    expect(Array.from(u.state)).toEqual(Array.from(state));
    // 観測は乗り換えた時刻より後だけが残る
    expect(engine.observationLog.every((o) => o.t > 900)).toBe(true);
  });
});
