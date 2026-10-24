// 実物らしい撮影条件のプリセット: 艶の映り込み（点光源）、丸い角、カメラの色合い・白飛び、ぼけ、キューブを持つ指。
// 指はキューブの見えている角の位置に合わせて置き、手の検出のマスク（多少ずれる・検出漏れあり）も返す。
import { ORIENTATIONS, type Vec3 } from "../src/cube/model";
import { type Finger, type Realism, type RenderOptions, fingerPolygon, mulMat, projectPoint } from "./render";

export type Harshness = "mild" | "real" | "harsh";

export interface SceneOptions {
  harshness: Harshness;
  fingers: "none" | "hold" | "heavy";
  backdrop?: Realism["backdrop"];
  maskQuality?: number; // 手の検出: 1 = 正確、0.5 = ずれ・取りこぼしあり、0 = 検出なし
}

const mat = (m: readonly number[], v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

export function scene(base: Pick<RenderOptions, "width" | "height" | "eye" | "orient" | "rotation" | "offset" | "focal">, t: number, o: SceneOptions, rnd: () => number): { realism: Realism; hands: [number, number][][] } {
  const world = base.rotation ? mulMat(base.rotation, ORIENTATIONS[base.orient]) : [...ORIENTATIONS[base.orient]];
  const off = base.offset ?? [0, 0, 0];
  const P = (p: Vec3) => projectPoint(base, [mat(world, p)[0] + off[0], mat(world, p)[1] + off[1], mat(world, p)[2] + off[2]] as Vec3);
  const level = { mild: 0.4, real: 1, harsh: 1.6 }[o.harshness];
  // 光源: 天井の照明（強く小さい）と窓（弱く大きい）。キューブが揺れると映り込みの位置が動く
  // 光源は「映り込みが面にかかる位置」（視線を面で鏡に映した方向）に置き、時間とともに少し動かす。
  // 正面の面には窓・モニター、上の面には天井の照明が映る
  const eye = base.eye;
  const mirror = (n: Vec3, c: Vec3, dist: number, wob: number): Vec3 => {
    const v = [eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]];
    const l = Math.hypot(v[0], v[1], v[2]);
    const V = v.map((x) => x / l);
    const d = V[0] * n[0] + V[1] * n[1] + V[2] * n[2];
    const R = [2 * d * n[0] - V[0], 2 * d * n[1] - V[1], 2 * d * n[2] - V[2]];
    return [c[0] + R[0] * dist + Math.sin(t / 700 + wob) * 2.2, c[1] + R[1] * dist + Math.cos(t / 900 + wob) * 1.6, c[2] + R[2] * dist] as Vec3;
  };
  const front = mat(world, [0, 0, 1]);
  const top = mat(world, [0, 1, 0]);
  const lights = [
    { pos: mirror(front, front.map((v) => v * 1.5) as Vec3, 12, 0), strength: 0.9 * level, shininess: 900 },
    { pos: mirror(top, top.map((v) => v * 1.5) as Vec3, 12, 2), strength: 0.7 * level, shininess: 900 },
    // 艶のぼんやりした反射（面全体が少し白っぽくなる）
    { pos: mirror(front, front.map((v) => v * 1.5) as Vec3, 12, 1), strength: 0.06 * level, shininess: 25 },
  ];
  const realism: Realism = {
    corner: 0.35,
    lights,
    shading: 0.25 * level,
    whiteBalance: o.harshness === "mild" ? [1.02, 1, 0.97] : [1.07, 1, 0.84],
    exposure: o.harshness === "harsh" ? 1.3 : o.harshness === "real" ? 1.12 : 1,
    blur: o.harshness === "mild" ? 0 : 1,
    backdrop: o.backdrop,
    fingers: [],
  };
  const fingers: Finger[] = [];
  if (o.fingers !== "none") {
    // 正面（カメラ側の面）の下の 2 つの角に親指。キューブ座標で正面 = カメラに一番向いた面
    const cam = base.eye;
    const faces: Vec3[] = [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 0, -1], [-1, 0, 0], [0, -1, 0]];
    const toCam = faces.map((n) => mat(world, n)).map((n) => n[0] * cam[0] + n[1] * cam[1] + n[2] * cam[2]);
    const fi = toCam.indexOf(Math.max(...toCam));
    const n = faces[fi];
    // 正面の面内の 2 軸（画像の右・下に近いもの）
    const axes: Vec3[] = faces.filter((a) => Math.abs(a[0] * n[0] + a[1] * n[1] + a[2] * n[2]) < 0.5);
    const center = P(n.map((v) => v * 1.5) as Vec3);
    const pick = (dx: number, dy: number) => axes.reduce((best, a) => {
      const q = P([n[0] * 1.5 + a[0] * 1.5, n[1] * 1.5 + a[1] * 1.5, n[2] * 1.5 + a[2] * 1.5]);
      const s = (q[0] - center[0]) * dx + (q[1] - center[1]) * dy;
      return s > best.s ? { s, a } : best;
    }, { s: -Infinity, a: axes[0] }).a;
    const down = pick(0, 1);
    const rightA = pick(1, 0);
    const corner = (sx: number, sy: number, depth = 1.5) => P([n[0] * depth + rightA[0] * 1.5 * sx + down[0] * 1.5 * sy, n[1] * depth + rightA[1] * 1.5 * sx + down[1] * 1.5 * sy, n[2] * depth + rightA[2] * 1.5 * sx + down[2] * 1.5 * sy]);
    const pitch = Math.hypot(corner(1, 0)[0] - corner(0, 0)[0], corner(1, 0)[1] - corner(0, 0)[1]) / 1.5; // 1 マスの大きさ（px）
    const wig = (k: number) => Math.sin(t / (230 + k * 40) + k) * pitch * 0.15;
    // 親指: 画面の下の外から、正面の下の角のマスの上まで。ときどき持ち替えて、マスから外れる
    for (const sx of [-1, 1]) {
      const off = Math.max(0, Math.sin(t / 650 + sx * 1.3)) * 0.75;
      const tip = corner(sx * 0.75, 0.7 + off);
      fingers.push({ a: [tip[0] + sx * pitch * 1.2, tip[1] + pitch * 3], b: [tip[0] + wig(sx + 2), tip[1] + wig(sx + 4)], width: pitch * 0.85 });
    }
    if (o.fingers === "heavy") {
      // 人差し指: 上の面の手前の辺にかかる。中指: 横の面にかかる
      for (const sx of [-1, 1]) {
        const tip = corner(sx * 0.55, -1.15, 1.2);
        fingers.push({ a: [tip[0] + sx * pitch * 2.5, tip[1] - pitch * 1.5], b: [tip[0] + wig(sx + 6), tip[1] + wig(sx + 8)], width: pitch * 0.8 });
        const side = corner(sx * 1.25, 0.1, 1.0);
        fingers.push({ a: [side[0] + sx * pitch * 2.5, side[1] + pitch * 0.5], b: [side[0], side[1]], width: pitch * 0.85 });
      }
      // 回している途中の指が正面の中央を横切ることがある
      if (Math.sin(t / 310) > 0.6) {
        const mid = corner(0.2 * Math.sin(t / 97), -0.1);
        fingers.push({ a: [mid[0] + pitch * 3, mid[1] + pitch * 2], b: mid, width: pitch * 0.8 });
      }
    }
  }
  realism.fingers = fingers;
  // 手の検出のマスク: 品質が低いと、ずれたり、指を取りこぼしたりする
  const q = o.maskQuality ?? 1;
  const hands = q <= 0 ? [] : fingers.filter(() => rnd() < 0.5 + q / 2).map((fg) => fingerPolygon({ ...fg, a: [fg.a[0] + (1 - q) * 8 * (rnd() - 0.5), fg.a[1]], b: [fg.b[0] + (1 - q) * 10 * (rnd() - 0.5), fg.b[1] + (1 - q) * 10 * (rnd() - 0.5)] }, 1.15));
  return { realism, hands };
}
