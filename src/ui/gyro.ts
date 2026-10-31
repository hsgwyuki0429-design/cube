// 3D キューブの向き（ジャイロのようにカメラに映ったキューブの傾きに追従する）をなめらかにする。DOM は知らない。
//
// 毎フレームの姿勢は、認識が 1 秒 7〜20 枚しか出ず、1 枚ごとに数度の揺れがある。そのまま追うと、止まっている間も細かく震え、
// 次の姿勢が届くたびに短い距離を一気に動いて「止まっては跳ぶ」動きになっていた。
//   1. 揺れを除く: 届いた姿勢を、回る速さに合わせた低域通過（One Euro フィルタ）でならす。ゆっくりなら強くならして震えを消し、
//      速く回すときは弱めて遅れを小さくする
//   2. 姿勢の間をつなぐ: ならした姿勢の回る速さで、次の姿勢が届くまで先へ進める（PREDICT_MS まで）。表示はそれを時間でなめらかに
//      追う（表示の時定数 RENDER_TAU_MS）ので、姿勢の届く間隔によらず動きが途切れない
import { Quaternion, Vector3 } from "three";

export interface GyroOptions {
  minCutoff: number; // 止まっているときの低域通過のしきい（Hz）。小さいほど強くならす
  beta: number; // 回る速さ（rad/s）1 あたりに、しきいを上げる量（Hz）
  dCutoff: number; // 回る速さそのものをならすしきい（Hz）
  snap: number; // これより大きく変わったら（持ち替え・見失いから戻った）ならさずに合わせる（ラジアン）
  predictMs: number; // 次の姿勢が届くまで、回る速さで先へ進める長さの上限
  predictMin: number; // これより遅い（rad/s）ときは先へ進めない（止まっているときの揺れを先へ伸ばさない）
  renderTauMs: number; // 表示が目標の向きを追う時定数
}

export const DEFAULT_GYRO: GyroOptions = { minCutoff: 0.4, beta: 1.5, dCutoff: 1, snap: (60 * Math.PI) / 180, predictMs: 150, predictMin: (15 * Math.PI) / 180, renderTauMs: 70 };

const alphaOf = (cutoffHz: number, dtMs: number) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / Math.max(1e-3, dtMs / 1000));
};

// q の回転ベクトル（軸 × 角度、ラジアン）
function rotVec(q: Quaternion): Vector3 {
  const w = Math.min(1, Math.abs(q.w));
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(1 - w * w);
  if (s < 1e-9) return new Vector3();
  const sign = q.w < 0 ? -1 : 1;
  return new Vector3(q.x, q.y, q.z).multiplyScalar((sign * angle) / s);
}

const fromRotVec = (v: Vector3): Quaternion => {
  const angle = v.length();
  return angle < 1e-9 ? new Quaternion() : new Quaternion().setFromAxisAngle(v.clone().divideScalar(angle), angle);
};

export class GyroFilter {
  private q: Quaternion | null = null; // ならした姿勢
  private t = 0; // 最後に届いた時刻（ms）
  private omega = new Vector3(); // ならした回る速さ（ワールドの軸、rad/ms）
  private speed = 0; // ならした回る速さの大きさ（rad/s）
  constructor(readonly options: GyroOptions = DEFAULT_GYRO) {}

  reset(q: Quaternion | null = null, t = 0): void {
    this.q = q ? q.clone() : null;
    this.t = t;
    this.omega.set(0, 0, 0);
    this.speed = 0;
  }

  // 姿勢が届いた（t: ms）
  push(q: Quaternion, t: number): void {
    const o = this.options;
    if (!this.q || t <= this.t) {
      this.reset(q, t);
      return;
    }
    const dt = t - this.t;
    const delta = rotVec(q.clone().multiply(this.q.clone().invert()));
    const angle = delta.length();
    if (angle > o.snap) {
      this.reset(q, t);
      return;
    }
    // 回る速さは、ならした姿勢の動きから（届いた姿勢そのものの差から求めると、交互に揺れるだけで速く回っているように見える）
    const a = alphaOf(o.minCutoff + o.beta * this.speed, dt);
    const step = delta.clone().multiplyScalar(a);
    // 速く回り始めたら（届いた姿勢が続けて同じ向きに離れていく）すぐ追えるよう、差の半分も速さに入れる
    const seen = Math.max(step.length(), angle * 0.5 * Math.max(0, step.clone().normalize().dot(this.omega.clone().normalize()) || 0));
    this.speed += alphaOf(o.dCutoff, dt) * ((seen / dt) * 1000 - this.speed);
    this.q = fromRotVec(step).multiply(this.q);
    // 回る速さ: ならした姿勢の動き。急に変わらないよう半分ずつ寄せる
    this.omega.lerp(step.divideScalar(dt), 0.5);
    this.t = t;
  }

  // 時刻 now に向くべき向き（届いた姿勢の後は、回る速さで PREDICT_MS まで先へ進める）
  target(now: number): Quaternion | null {
    if (!this.q) return null;
    if (this.speed < this.options.predictMin) return this.q.clone();
    const ahead = Math.min(Math.max(0, now - this.t), this.options.predictMs);
    return fromRotVec(this.omega.clone().multiplyScalar(ahead)).multiply(this.q);
  }

  // 回っているか（表示を動かし続けるか）
  moving(now: number): boolean {
    return this.speed >= this.options.predictMin && now - this.t < this.options.predictMs;
  }
}

// 表示の向き cur を、目標 target へ時間 dtMs の分だけ寄せる（時定数 tauMs。フレームの間隔によらず同じ速さで追う）
export function follow(cur: Quaternion, target: Quaternion, dtMs: number, tauMs = DEFAULT_GYRO.renderTauMs): void {
  cur.slerp(target, 1 - Math.exp(-Math.max(0, dtMs) / tauMs));
}

const quatOf = (m: readonly number[]): Quaternion => {
  // 行優先 3×3 → 四元数（three の Matrix4 は列優先で持つ）
  const e = [m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0, 0, 0, 0, 1];
  return new Quaternion().setFromRotationMatrix({ elements: e } as never);
};

const matOf = (q: Quaternion): number[] => {
  const { x, y, z, w } = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
};

// 解析した動画の姿勢（フレームごとの回転、行優先 3×3。null = 求まらない）を、フレーム i のまわりで時間の重み（σ = sigmaMs）を付けて
// 平均する（動画の解析: 後から全フレームを見られるので、前後のフレームでならす）。i の姿勢から maxDeg 以上離れたもの（面の割り当てが
// 変わった・誤った姿勢）は使わない
export function smoothedPose(poses: (readonly number[] | null)[], times: number[], i: number, sigmaMs = 50, maxDeg = 30): number[] | null {
  const center = poses[i];
  if (!center) return null;
  const q0 = quatOf(center);
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  const cosMax = Math.cos((maxDeg * Math.PI) / 360);
  for (let k = i; k >= 0 && times[i] - times[k] <= 3 * sigmaMs; k--) add(k);
  for (let k = i + 1; k < poses.length && times[k] - times[i] <= 3 * sigmaMs; k++) add(k);
  function add(k: number) {
    const p = poses[k];
    if (!p) return;
    const q = quatOf(p);
    let d = q.dot(q0);
    if (d < 0) {
      q.set(-q.x, -q.y, -q.z, -q.w);
      d = -d;
    }
    if (d < cosMax) return;
    const g = Math.exp(-((times[k] - times[i]) ** 2) / (2 * sigmaMs * sigmaMs));
    x += q.x * g;
    y += q.y * g;
    z += q.z * g;
    w += q.w * g;
  }
  return matOf(new Quaternion(x, y, z, w).normalize());
}
