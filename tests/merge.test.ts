import { describe, expect, it } from "vitest";
import { moveIndex } from "../src/cube/model";
import { cancelInverses, mergeQuickRepeats } from "../src/track/merge";

const mv = (name: string, t: number) => ({ move: moveIndex(name), t, orient: 0 });

describe("mergeQuickRepeats", () => {
  it("素早い R R は R2、R R' は消える、間が空けば別の手", () => {
    expect(mergeQuickRepeats([mv("R", 0), mv("R", 200)]).map((m) => m.move)).toEqual([moveIndex("R2")]);
    expect(mergeQuickRepeats([mv("R", 0), mv("R'", 200)])).toEqual([]);
    expect(mergeQuickRepeats([mv("R", 0), mv("R", 900)]).length).toBe(2);
    expect(mergeQuickRepeats([mv("U", 0), mv("R", 100), mv("R", 300), mv("U'", 500)]).map((m) => m.move)).toEqual([moveIndex("U"), moveIndex("R2"), moveIndex("U'")]);
  });

  it("観測の間隔が空いても（遅いカメラ）、止まらずに続けて回していれば 1 手にまとめる", () => {
    const timed = (name: string, start: number, end: number) => ({ ...mv(name, end), start, end });
    const merged = mergeQuickRepeats([timed("F", 1490, 1730), timed("F", 1730, 2210)]);
    expect(merged.map((m) => [m.move, m.start, m.end])).toEqual([[moveIndex("F2"), 1490, 2210]]);
    // 一度止まってから回したなら別の手
    expect(mergeQuickRepeats([timed("F", 0, 300), timed("F", 900, 1200)]).length).toBe(2);
  });

  it("打ち消し合う手を取り除く（間の手が隣り合えば続けて）", () => {
    const seq = (s: string) => s.split(" ").map((n, i) => mv(n, i * 100));
    const names = (ms: { move: number }[]) => ms.map((m) => m.move);
    expect(names(cancelInverses(seq("R F R2 R2 F' U R'")))).toEqual(names(seq("R U R'")));
    expect(names(cancelInverses(seq("R L R' U")))).toEqual(names(seq("R L R' U")));
    // 打ち消さないもの（R R は R2 になる別の手、R U R' は別の手）はそのまま
    expect(names(cancelInverses(seq("R R U R'")))).toEqual(names(seq("R R U R'")));
  });
});
