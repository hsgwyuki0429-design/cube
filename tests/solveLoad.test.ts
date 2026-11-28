import { describe, expect, it } from "vitest";
import { parseSolveLoad } from "../src/app/solveLoad";

describe("?solveload=", () => {
  it("既定は vframe。default で今までのやり方に戻す", () => {
    expect(parseSolveLoad("")).toEqual({ refine: "full", helper: "on", lazy: false, vframe: true });
    expect(parseSolveLoad("default").vframe).toBe(false);
    expect(parseSolveLoad("pause")).toEqual({ refine: "pause", helper: "on", lazy: false, vframe: true });
    expect(parseSolveLoad("default,duty50,helperoff,lazy")).toEqual({ refine: "duty50", helper: "off", lazy: true, vframe: false });
    // 前の名前（vframe）を付けたままの URL も同じ
    expect(parseSolveLoad("vframe").vframe).toBe(true);
  });
});
