// 使っているカメラの向き（src/app/settings.ts の facingOf）: 鏡像と、持ち方基準の表記の向き（インカメラなら自分から見た向き、
// 背面ならカメラから見た向き）を決める。自分から見た向きに固定していた間は、背面カメラでスクランブルの案内の左右・前後が逆だった
import { describe, expect, it } from "vitest";
import { facingOf } from "../src/app/settings";

describe("カメラの向き", () => {
  it("カメラが教える向きを優先する", () => {
    expect(facingOf({ facingMode: "environment", label: "前面カメラ" }, "user")).toBe("environment");
    expect(facingOf({ facingMode: "user" }, "environment")).toBe("user");
  });
  it("向きが分からなければ名前から", () => {
    expect(facingOf({ label: "背面超広角カメラ" }, "user")).toBe("environment");
    expect(facingOf({ label: "背面デュアル広角カメラ" }, "user")).toBe("environment");
    expect(facingOf({ label: "Back Ultra Wide Camera" }, "user")).toBe("environment");
    expect(facingOf({ label: "前面カメラ" }, "environment")).toBe("user");
    expect(facingOf({ label: "FaceTime HD Camera" }, "environment")).toBe("user");
  });
  it("どちらも分からなければ頼んだ向き（PC の内蔵カメラなど）", () => {
    expect(facingOf({ label: "Integrated Webcam" }, "user")).toBe("user");
    expect(facingOf(null, "environment")).toBe("environment");
  });
});
