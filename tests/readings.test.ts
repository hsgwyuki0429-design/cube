import { describe, expect, it } from "vitest";
import { cellReads } from "../src/ui/readings";

describe("読み取りの図のマス", () => {
  it("直接読んだ ID・引き継いだ ID・ID なしを分ける", () => {
    const ids = [18, 19, -1, 21, 22, 23, -1, 25, 26];
    const shift = [[0, 0], null, null, [0.1, 0], null, [0, 0], null, null, [0, 0]] as ([number, number] | null)[];
    expect(cellReads({ ids, shift })).toEqual(["direct", "kept", "none", "direct", "kept", "direct", "none", "kept", "direct"]);
    // ID がない面・ずれの情報がない面
    expect(cellReads({})).toEqual(new Array(9).fill("none"));
    expect(cellReads({ ids })).toEqual(ids.map((id) => (id < 0 ? "none" : "kept")));
  });
});
