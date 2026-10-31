// 3D キューブの向きをなめらかにする（src/ui/gyro.ts）: 止まっているときの揺れを除き、回すときは遅れず、姿勢の間をつなぐ
import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { GyroFilter, follow, smoothedPose } from "../src/ui/gyro";

const Y = new Vector3(0, 1, 0);
const rotY = (deg: number) => new Quaternion().setFromAxisAngle(Y, (deg * Math.PI) / 180);
const deg = (a: Quaternion, b: Quaternion) => (a.angleTo(b) * 180) / Math.PI;

describe("ジャイロの向きをならす", () => {
  it("止まっていて 1 枚ごとに ±3° 揺れる姿勢（7fps）は、揺れが 1° 以下になる", () => {
    const g = new GyroFilter();
    let worst = 0;
    for (let k = 0; k < 40; k++) {
      const t = k * 140;
      g.push(rotY(k % 2 ? 3 : -3), t);
      if (k > 10) worst = Math.max(worst, deg(g.target(t)!, rotY(0)));
    }
    expect(worst).toBeLessThan(1);
  });

  it("一定の速さ（90°/秒）で回すと、姿勢の間も回る速さで進み、遅れは小さい", () => {
    const g = new GyroFilter();
    for (let k = 0; k <= 20; k++) g.push(rotY(k * 12.6), k * 140); // 90°/秒・140ms ごと
    const t = 20 * 140;
    // 届いた直後の遅れ
    expect(deg(g.target(t)!, rotY(20 * 12.6))).toBeLessThan(10);
    // 次の姿勢が届く前（70ms 後）も先へ進んでいる
    const ahead = g.target(t + 70)!;
    expect(deg(ahead, rotY(20 * 12.6 + 6.3))).toBeLessThan(10);
    expect(deg(ahead, g.target(t)!)).toBeGreaterThan(3);
  });

  it("大きく変わったら（持ち替え）ならさずに合わせる", () => {
    const g = new GyroFilter();
    g.push(rotY(0), 0);
    g.push(rotY(0), 140);
    g.push(rotY(90), 280);
    expect(deg(g.target(280)!, rotY(90))).toBeLessThan(0.1);
  });

  it("表示は時間でなめらかに追う（フレームの間隔によらない）", () => {
    const a = rotY(0);
    const b = rotY(0);
    for (let k = 0; k < 6; k++) follow(a, rotY(40), 16.7);
    follow(b, rotY(40), 100);
    expect(Math.abs(deg(a, rotY(40)) - deg(b, rotY(40)))).toBeLessThan(0.5);
  });

  it("動画の姿勢は前後のフレームで平均する（離れすぎた姿勢は使わない）", () => {
    const m = (q: Quaternion) => {
      const e = new Array(9);
      const { x, y, z, w } = q;
      e[0] = 1 - 2 * (y * y + z * z);
      e[1] = 2 * (x * y - z * w);
      e[2] = 2 * (x * z + y * w);
      e[3] = 2 * (x * y + z * w);
      e[4] = 1 - 2 * (x * x + z * z);
      e[5] = 2 * (y * z - x * w);
      e[6] = 2 * (x * z - y * w);
      e[7] = 2 * (y * z + x * w);
      e[8] = 1 - 2 * (x * x + y * y);
      return e;
    };
    const poses = [m(rotY(-4)), m(rotY(4)), m(rotY(-4)), m(rotY(4)), m(rotY(80)), null];
    const times = [0, 8, 16, 25, 33, 41];
    const out = smoothedPose(poses, times, 2)!;
    // 回転行列の (0,2) = sin θ
    expect(Math.abs((Math.asin(out[2]) * 180) / Math.PI)).toBeLessThan(2);
    expect(smoothedPose(poses, times, 5)).toBeNull();
  });
});
