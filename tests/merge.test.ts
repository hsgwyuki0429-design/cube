import { describe, expect, it } from "vitest";
import { moveIndex } from "../src/cube/model";
import { mergeQuickRepeats } from "../src/track/merge";

const mv = (name: string, t: number) => ({ move: moveIndex(name), t, orient: 0 });

describe("mergeQuickRepeats", () => {
  it("素早い R R は R2、R R' は消える、間が空けば別の手", () => {
    expect(mergeQuickRepeats([mv("R", 0), mv("R", 200)]).map((m) => m.move)).toEqual([moveIndex("R2")]);
    expect(mergeQuickRepeats([mv("R", 0), mv("R'", 200)])).toEqual([]);
    expect(mergeQuickRepeats([mv("R", 0), mv("R", 900)]).length).toBe(2);
    expect(mergeQuickRepeats([mv("U", 0), mv("R", 100), mv("R", 300), mv("U'", 500)]).map((m) => m.move)).toEqual([moveIndex("U"), moveIndex("R2"), moveIndex("U'")]);
  });
});
