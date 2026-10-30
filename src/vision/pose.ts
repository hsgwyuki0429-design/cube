// キューブの連続的な姿勢（カメラに対する傾き）を、見つかった面の格子から求める。
//
// 認識は面をカメラフレームの面（正面=F、上=U、右=R…）に割り当てるので、ここで求めるのは
// 「カメラフレームにぴったり揃ったキューブ」から実際のキューブまでの残りの回転（±45° 程度）。
// これに追跡の離散的な姿勢（24 通り）を掛けると、キューブ固定フレーム → カメラの回転になる。
//
// 面の格子の各点（角・辺の中点・中心）の 3D 座標は既知（キューブの大きさ 3）なので、PnP 問題として
// 正面の面の射影変換から初期値を作り、見えている全部の面の点で再投影誤差を最小化する（ガウス・ニュートン）。
// 焦点距離は分からないので、スマホやPCのカメラの典型的な画角から仮定する（多少ずれても回転はほぼ合う）。
import { COLDIR, F, NORMAL, ROWDIR, type Vec3 } from "../cube/model";
import { type Mat3, type Pt, fitHomography } from "./homography";
import { slotPoint } from "./layout";

export interface PoseFace {
  slot: number;
  H: Mat3;
  rot: number;
  held?: boolean;
}

export interface Pose {
  R: number[]; // 3x3 行優先。カメラフレームに揃ったキューブ → 実際（+x = 画像の右、+y = 上、+z = カメラ側）
  t: Vec3; // キューブの中心（カメラ座標、+z = カメラ側。単位はキューブの 1/3）
  err: number; // 再投影誤差（px、二乗平均）
  faces: number;
}

const LATTICE: Pt[] = [
  [0, 0],
  [1.5, 0],
  [3, 0],
  [0, 1.5],
  [1.5, 1.5],
  [3, 1.5],
  [0, 3],
  [1.5, 3],
  [3, 3],
];

// スロットの格子座標 (x = 列方向, y = 行方向, 0..3) → カメラフレームに揃ったキューブの座標
export function latticePoint(slot: number, x: number, y: number): Vec3 {
  const n = NORMAL[slot];
  const c = COLDIR[slot];
  const r = ROWDIR[slot];
  return [0, 1, 2].map((k) => 1.5 * n[k] + c[k] * (x - 1.5) + r[k] * (y - 1.5)) as Vec3;
}

function rodrigues(w: number[]): number[] {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const [x, y, z] = [w[0] / th, w[1] / th, w[2] / th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const v = 1 - c;
  return [c + x * x * v, x * y * v - z * s, x * z * v + y * s, y * x * v + z * s, c + y * y * v, y * z * v - x * s, z * x * v - y * s, z * y * v + x * s, c + z * z * v];
}

// 回転行列 → 回転ベクトル
function logRot(R: number[]): number[] {
  const cos = Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2));
  const th = Math.acos(cos);
  if (th < 1e-9) return [0, 0, 0];
  const k = th / (2 * Math.sin(th));
  if (Math.sin(th) < 1e-6) {
    // 180° 近く: 対角成分から軸を取る
    const ax = [Math.sqrt(Math.max(0, (R[0] + 1) / 2)), Math.sqrt(Math.max(0, (R[4] + 1) / 2)), Math.sqrt(Math.max(0, (R[8] + 1) / 2))];
    if (R[1] < 0) ax[1] = -ax[1];
    if (R[2] < 0) ax[2] = -ax[2];
    return ax.map((a) => a * th);
  }
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

const mul3 = (a: number[], b: number[]) => {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
};

const norm3 = (v: number[]) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// 6x6 の連立一次方程式（ガウスの消去法）
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// 焦点距離の仮定（px）。スマホや PC のカメラの画角は長辺方向で 65〜75° 程度なので、長辺の 0.8 倍。
// 縦向きの動画では短辺（幅）が基準だと画角を広く見積もりすぎ、傾きが大きく狂う
export function defaultFocal(width: number, height: number): number {
  return Math.max(width, height) * 0.8;
}

// 画像処理の座標系（x 右・y 下・z 奥）とアプリのカメラフレーム（x 右・y 上・z 手前）の変換
const flip = (v: number[]) => [v[0], -v[1], -v[2]];
const FLIP = [1, 0, 0, 0, -1, 0, 0, 0, -1];

// center: 画像上の光軸の位置（既定は画像の中心。切り出した画像ではフレームの中心）
export function estimatePose(faces: PoseFace[], width: number, height: number, focal = defaultFocal(width, height), center: Pt = [width / 2, height / 2]): Pose | null {
  const used = faces.filter((f) => !f.held);
  const front = used.find((f) => f.slot === F);
  if (!front) return null;
  const [cx, cy] = center;
  const pts3: number[][] = []; // 画像処理の座標系
  const pts2: Pt[] = [];
  for (const f of used) {
    for (const [x, y] of LATTICE) {
      const p = slotPoint(f, x, y);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      pts3.push(flip(latticePoint(f.slot, x, y)));
      pts2.push(p);
    }
  }
  if (pts3.length < 6) return null;

  // 初期値: 正面の面の射影変換を分解する。正面の点は（画像処理の座標系で）(X, Y, -1.5)
  const corners: Pt[] = [
    [-1.5, -1.5],
    [1.5, -1.5],
    [1.5, 1.5],
    [-1.5, 1.5],
  ];
  const H = fitHomography(
    corners,
    corners.map(([X, Y]) => slotPoint(front, X + 1.5, Y + 1.5)),
  );
  if (!H) return null;
  const kinv = (c: number[]) => [(c[0] - cx * c[2]) / focal, (c[1] - cy * c[2]) / focal, c[2]];
  const a1 = kinv([H[0], H[3], H[6]]);
  const a2 = kinv([H[1], H[4], H[7]]);
  const a3 = kinv([H[2], H[5], H[8]]);
  let lam = 2 / (Math.hypot(...a1) + Math.hypot(...a2));
  if (a3[2] * lam < 0) lam = -lam; // 面はカメラの前
  const r1 = norm3(a1.map((v) => v * lam));
  let r2 = a2.map((v) => v * lam);
  r2 = norm3(r2.map((v, i) => v - dot3(r1, r2) * r1[i]));
  const r3 = cross3(r1, r2);
  const R0 = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
  // 面の中心 = R·(0,0,-1.5) + t
  const tp = a3.map((v) => v * lam);
  let t = [tp[0] + 1.5 * r3[0], tp[1] + 1.5 * r3[1], tp[2] + 1.5 * r3[2]];
  let w = logRot(R0);

  const residuals = (wv: number[], tv: number[]): number[] => {
    const R = rodrigues(wv);
    const out: number[] = [];
    for (let i = 0; i < pts3.length; i++) {
      const P = pts3[i];
      const X = R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + tv[0];
      const Y = R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + tv[1];
      const Z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + tv[2];
      if (Z <= 0.1) {
        out.push(1e4, 1e4);
        continue;
      }
      out.push(cx + (focal * X) / Z - pts2[i][0], cy + (focal * Y) / Z - pts2[i][1]);
    }
    return out;
  };
  const sq = (r: number[]) => r.reduce((s, v) => s + v * v, 0);

  // レーベンバーグ・マーカート法（数値微分）
  let params = [...w, ...t];
  let r = residuals(w, t);
  let cost = sq(r);
  let damping = 1e-3;
  for (let it = 0; it < 15; it++) {
    const J: number[][] = [];
    for (let k = 0; k < 6; k++) {
      const p2 = [...params];
      const h = k < 3 ? 1e-5 : 1e-4;
      p2[k] += h;
      const r2v = residuals(p2.slice(0, 3), p2.slice(3));
      J.push(r2v.map((v, i) => (v - r[i]) / h));
    }
    const A = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => J[i].reduce((s, v, n) => s + v * J[j][n], 0)));
    const g = Array.from({ length: 6 }, (_, i) => -J[i].reduce((s, v, n) => s + v * r[n], 0));
    let improved = false;
    for (let tries = 0; tries < 5 && !improved; tries++) {
      const Ad = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + damping) + 1e-9 : v)));
      const d = solve(Ad, g);
      if (!d) break;
      const cand = params.map((v, i) => v + d[i]);
      const rc = residuals(cand.slice(0, 3), cand.slice(3));
      const cc = sq(rc);
      if (cc < cost) {
        params = cand;
        r = rc;
        const gain = cost - cc;
        cost = cc;
        damping = Math.max(1e-6, damping / 3);
        improved = true;
        if (gain < 1e-6 * cost) it = 99;
      } else damping *= 4;
    }
    if (!improved) break;
  }
  w = params.slice(0, 3);
  t = params.slice(3);
  // アプリのカメラフレームへ: R_app = FLIP · R · FLIP
  const Rapp = mul3(mul3(FLIP, rodrigues(w)), FLIP);
  return { R: Rapp, t: flip(t) as Vec3, err: Math.sqrt(cost / pts3.length), faces: new Set(used.map((f) => f.slot)).size };
}

// 2 つの回転の間の角度（ラジアン）
export function rotationAngle(a: number[], b: number[]): number {
  // a^T b のトレース
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += a[k * 3 + i] * b[k * 3 + i];
  return Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2)));
}
