// 確かな所から埋める解き直し（src/track/exact.ts）と確認役
import { describe, expect, it } from "vitest";
import { type CubeState, VIEW, applyMove, applyMoves, parseMoves, solvedState } from "../src/cube/model";
import { stickerIds } from "../src/cube/stickers";
import { type Sighting, canonicalMoves, decodeExact, verifyMoves } from "../src/track/exact";
import type { DecodedMove } from "../src/track/types";

// 姿勢 o で正面・上・右の 3 面が見えるフレームの読み
function sighting(state: CubeState, o: number, t: number, slots = [0, 1, 2]): Sighting {
  const ids = stickerIds(state);
  return { t, faces: slots.map((slot) => ({ slot, ids: Array.from({ length: 9 }, (_, c) => ids[VIEW[o * 54 + slot * 9 + c]]) })) };
}

// 手ごとに、止まっている 6 枚（60fps）と回している途中の読めない 3 枚
function film(start: CubeState, moves: number[], o = 0, slots?: number[]): Sighting[] {
  const out: Sighting[] = [];
  let t = 0;
  let s = start;
  const still = () => {
    for (let k = 0; k < 6; k++) out.push(sighting(s, o, (t += 1000 / 60), slots));
  };
  still();
  for (const m of moves) {
    for (let k = 0; k < 3; k++) out.push({ t: (t += 1000 / 60), faces: [] });
    s = applyMove(s, m);
    still();
  }
  return out;
}

describe("decodeExact", () => {
  const start = applyMoves(solvedState(), "R U F' L2 D B' R2 U'");
  it("見えている面の手順を復元する", () => {
    const truth = parseMoves("R U R' U' F2 D' L B");
    const end = applyMoves(start, truth);
    const r = decodeExact(film(start, truth), start, end);
    expect(r.reachedEnd).toBe(true);
    expect(r.method).toBe("meet");
    expect(canonicalMoves(r.moves.map((m) => m.move))).toEqual(canonicalMoves(truth));
    expect(r.moves.filter((m) => m.inferred)).toHaveLength(0);
  });

  it("速い連続（間のフレームなし）も両側から埋める", () => {
    const truth = parseMoves("R U R' U' R' F R2 U' R' U' R U R' F'");
    const end = applyMoves(start, truth);
    // 3 手ごとにしか止まって見えない
    const out: Sighting[] = [];
    let t = 0;
    let s = start;
    const still = () => {
      for (let k = 0; k < 4; k++) out.push(sighting(s, 0, (t += 1000 / 60)));
    };
    still();
    truth.forEach((m, i) => {
      out.push({ t: (t += 1000 / 60), faces: [] }, { t: (t += 1000 / 60), faces: [] });
      s = applyMove(s, m);
      if (i % 3 === 2 || i === truth.length - 1) still();
    });
    const r = decodeExact(out, start, end);
    expect(r.reachedEnd).toBe(true);
    // 3 手まとめて見えない区間は、同じ見え方になる別の手順がありうる: 正しい手順か、違う所は推定
    const got = r.moves.map((m) => m.move);
    if (canonicalMoves(got).join() !== canonicalMoves(truth).join()) expect(r.moves.some((m) => m.inferred)).toBe(true);
  });
});

describe("verifyMoves", () => {
  const start = applyMoves(solvedState(), "F2 U' R B2 L");
  const truth = parseMoves("R U R' U' F2 D'");
  const end = applyMoves(start, truth);
  const exact = decodeExact(film(start, truth), start, end);
  const asDecoded = (ms: number[]): DecodedMove[] => ms.map((move, i) => ({ move, t: i, orient: 0 }));

  it("同じ手順はそのまま（反対の面の順番だけの違いも同じ）", () => {
    const v = verifyMoves(asDecoded(truth), exact);
    expect(v.agreed).toBe(true);
    expect(v.marked).toBe(0);
  });

  it("食い違う手を推定にする（確定のまま残さない）", () => {
    const wrong = [...truth];
    wrong[2] = parseMoves("R2")[0];
    const v = verifyMoves(asDecoded(wrong), exact);
    expect(v.agreed).toBe(false);
    expect(v.moves[2].inferred).toBe(true);
    expect(v.moves[0].inferred).toBeFalsy();
  });

  it("確かめられなければ何もしない", () => {
    const v = verifyMoves(asDecoded(truth), { ...exact, reachedEnd: false, method: "none" });
    expect(v.agreed).toBeNull();
    expect(v.moves.every((m) => !m.inferred)).toBe(true);
  });
});
